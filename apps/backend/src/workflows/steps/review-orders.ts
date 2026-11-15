import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { whatsappNumber } from "../../utils/whatsapp"

/** One product the customer bought on the order, as the review page shows it. */
export type ReviewLine = {
  id: string
  product_id: string
  variant_id: string | null
  product_title: string
  variant_title: string | null
  product_handle: string | null
  thumbnail: string | null
}

/** An order as reviews need it: who bought it, whether it arrived, and what was in it. */
export type ReviewOrder = {
  id: string
  display_id: number
  email: string | null
  customer_id: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  whatsapp_number: string | null
  whatsapp_opt_in: boolean
  canceled: boolean
  delivered_at: Date | null
  /** The parcel came back to us undelivered. */
  returned_to_sender: boolean
  lines: ReviewLine[]
}

/** The customer said yes to WhatsApp at checkout (stored on the cart, carried to the order). */
export function whatsappOptIn(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.whatsapp_opt_in === true
}

export async function loadReviewOrder(container: MedusaContainer, orderId: string): Promise<ReviewOrder | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "customer_id",
      "status",
      "metadata",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.phone",
      "items.id",
      "items.title",
      "items.product_id",
      "items.variant_id",
      "items.product_title",
      "items.product_handle",
      "items.variant_title",
      "items.thumbnail",
      "items.unit_price",
      "items.product.metadata",
    ],
    filters: { id: orderId },
  })
  const order = data[0] as any
  if (!order) return null

  let delivered: Date | null = null
  let returned = false
  try {
    const dispatches: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [dispatch] = await dispatches.listOrderDispatches({ order_id: orderId }, { take: 1 })
    delivered = dispatch?.delivered_at ? new Date(dispatch.delivered_at as any) : null
    returned = Boolean((dispatch as any)?.rto_delivered_at)
  } catch {
    // Without dispatch records nothing counts as delivered.
  }

  const seen = new Set<string>()
  const lines: ReviewLine[] = []
  for (const item of (order.items ?? []) as any[]) {
    // The complimentary tote and any line without a product cannot be reviewed.
    if (!item?.product_id || seen.has(item.product_id)) continue
    if (item.product?.metadata?.hidden_from_shop) continue
    seen.add(item.product_id)
    lines.push({
      id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id ?? null,
      product_title: item.product_title ?? item.title ?? "Your piece",
      variant_title: item.variant_title && item.variant_title !== "Default variant" ? item.variant_title : null,
      product_handle: item.product_handle ?? null,
      thumbnail: item.thumbnail ?? null,
    })
  }

  const phone = order.shipping_address?.phone ?? null
  return {
    id: order.id,
    display_id: Number(order.display_id),
    email: order.email ?? null,
    customer_id: order.customer_id ?? null,
    first_name: order.shipping_address?.first_name ?? null,
    last_name: order.shipping_address?.last_name ?? null,
    phone,
    whatsapp_number: whatsappNumber(phone),
    whatsapp_opt_in: whatsappOptIn(order.metadata),
    canceled: order.status === "canceled",
    delivered_at: delivered,
    returned_to_sender: returned,
    lines,
  }
}

export type Reviewable = { ok: true } | { ok: false; reason: "not_found" | "canceled" | "not_delivered" | "returned" | "nothing_to_review" }

/** Only an order that reached the customer can be reviewed. */
export function reviewable(order: ReviewOrder | null): Reviewable {
  if (!order) return { ok: false, reason: "not_found" }
  if (order.canceled) return { ok: false, reason: "canceled" }
  if (order.returned_to_sender) return { ok: false, reason: "returned" }
  if (!order.delivered_at) return { ok: false, reason: "not_delivered" }
  if (order.lines.length === 0) return { ok: false, reason: "nothing_to_review" }
  return { ok: true }
}
