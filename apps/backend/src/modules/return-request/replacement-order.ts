import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createOrdersWorkflow } from "@medusajs/medusa/core-flows"
import { createOrderDispatchWorkflow } from "../../workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../../workflows/dispatch-order"
import { postToStorefront } from "../../utils/storefront"
import { dispatchEnabled } from "../order-dispatch/config"
import { toNumber } from "../wallet/utils"
import { RETURN_REQUEST_MODULE } from "./index"
import type ReturnRequestModuleService from "./service"

type Address = Record<string, unknown>

type SourceOrder = {
  id: string
  display_id: number
  customer_id: string | null
  email: string | null
  region_id: string | null
  sales_channel_id: string | null
  currency_code: string
  shipping_address?: Address | null
  billing_address?: Address | null
}

const addressFields = [
  "first_name", "last_name", "phone", "company", "address_1", "address_2", "city", "province", "postal_code", "country_code",
] as const

function copyAddress(address: Address | null | undefined): Address | undefined {
  if (!address) return undefined
  const copy: Address = {}
  for (const field of addressFields) {
    if (address[field] !== undefined && address[field] !== null) copy[field] = address[field]
  }
  return copy
}

/**
 * Creates the replacement order for an exchange and sends it out. The customer
 * agreed the replacement's price when they asked, so that price is used even if
 * it has changed since; the order goes to the address of the order it replaces
 * and is marked as a replacement, so the courier collects nothing.
 *
 * The order is saved on the request the moment it exists, so a retry after any
 * failure finds it and never makes a second one. Its stock is reserved here
 * (an order made this way does not reserve any by itself), and it is shipped at
 * once rather than held, since the customer is already waiting.
 */
export async function createReplacementOrder(container: MedusaContainer, requestId: string): Promise<{ order_id: string; created: boolean }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

  const [request] = await service.listReturnRequests({ id: requestId }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
  if (request.replacement_order_id) {
    await ensureDispatched(container, request.replacement_order_id)
    return { order_id: request.replacement_order_id, created: false }
  }
  if (!request.replacement_variant_id) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "This exchange has no replacement chosen")
  }

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "customer_id", "email", "region_id", "sales_channel_id", "currency_code",
      "shipping_address.*", "billing_address.*",
    ],
    filters: { id: request.order_id },
  })
  const source = data[0] as unknown as SourceOrder | undefined
  if (!source) throw new MedusaError(MedusaError.Types.NOT_FOUND, "The original order was not found")

  const { result } = await createOrdersWorkflow(container).run({
    input: {
      region_id: source.region_id ?? undefined,
      sales_channel_id: source.sales_channel_id ?? undefined,
      customer_id: source.customer_id ?? undefined,
      email: source.email ?? undefined,
      currency_code: source.currency_code,
      status: "pending",
      shipping_address: copyAddress(source.shipping_address),
      billing_address: copyAddress(source.billing_address),
      items: [
        {
          variant_id: request.replacement_variant_id,
          quantity: 1,
          // The price the customer agreed to, not today's.
          unit_price: toNumber(request.replacement_price),
          is_tax_inclusive: false,
        },
      ],
      metadata: { replacement_for_order: source.id, exchange_request_id: request.id },
    } as never,
  })
  const created = result as unknown as { id: string; items?: { id: string }[] }

  // Remember it before anything else can fail, so a retry never makes another.
  await service.updateReturnRequests({ id: request.id, replacement_order_id: created.id })

  try {
    await reserveStock(container, created.id, request.replacement_variant_id)
  } catch (error) {
    logger.error(`[exchange] could not reserve stock for replacement order ${created.id}: ${(error as Error).message}`)
    await postToStorefront(
      "/api/ops/notify",
      { type: "replacement_stock_not_reserved", order_id: created.id, return_request_id: request.id, error: (error as Error).message },
      logger
    )
  }

  await ensureDispatched(container, created.id)
  return { order_id: created.id, created: true }
}

/** Reserves the replacement's stock at the first location that has it. */
async function reserveStock(container: MedusaContainer, orderId: string, variantId: string): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const inventory = container.resolve(Modules.INVENTORY)

  const { data: orders } = await query.graph({ entity: "order", fields: ["items.id", "items.variant_id"], filters: { id: orderId } })
  const line = ((orders[0] as unknown as { items?: { id: string; variant_id?: string }[] })?.items ?? []).find(
    (item) => item.variant_id === variantId
  )
  if (!line) throw new MedusaError(MedusaError.Types.NOT_FOUND, "the replacement line was not found on the new order")

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "manage_inventory",
      "inventory_items.inventory_item_id",
      "inventory_items.required_quantity",
      "inventory_items.inventory.location_levels.location_id",
      "inventory_items.inventory.location_levels.stocked_quantity",
      "inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { id: variantId },
  })
  const variant = variants[0] as unknown as {
    manage_inventory?: boolean
    inventory_items?: {
      inventory_item_id: string
      required_quantity?: number
      inventory?: { location_levels?: { location_id: string; stocked_quantity: unknown; reserved_quantity: unknown }[] }
    }[]
  }
  if (variant?.manage_inventory === false) return

  const reservations: { line_item_id: string; inventory_item_id: string; location_id: string; quantity: number }[] = []
  for (const link of variant?.inventory_items ?? []) {
    const needed = Number(link.required_quantity ?? 1)
    const level = (link.inventory?.location_levels ?? []).find(
      (entry) => Number(entry.stocked_quantity) - Number(entry.reserved_quantity) >= needed
    )
    if (!level) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "no location has the replacement in stock")
    reservations.push({ line_item_id: line.id, inventory_item_id: link.inventory_item_id, location_id: level.location_id, quantity: needed })
  }
  if (reservations.length) await inventory.createReservationItems(reservations)
}

/** Starts the replacement's shipment now: no cancel window, since the customer is already waiting. */
async function ensureDispatched(container: MedusaContainer, orderId: string): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!dispatchEnabled()) return
  try {
    await createOrderDispatchWorkflow(container).run({ input: { order_id: orderId, window_minutes: 0 } })
    await dispatchOrderWorkflow(container).run({ input: { order_id: orderId } })
  } catch (error) {
    // The dispatch job picks the order up and retries, so this is not fatal.
    logger.error(`[exchange] could not start dispatch for replacement order ${orderId}: ${(error as Error).message}`)
  }
}
