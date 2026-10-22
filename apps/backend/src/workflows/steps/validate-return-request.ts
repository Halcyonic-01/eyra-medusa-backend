import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { OPEN_STATUSES, RETURN_REASON_CODES, feeWaivedFor } from "../../modules/return-request/constants"
import { deliveryStateOf, returnWindowEnds, withinReturnWindow } from "../../modules/return-request/eligibility"
import { fromStoredItems, type RequestedItem } from "../../modules/return-request/items"
import { paidValueOf, paidValues } from "../../modules/return-request/pricing"
import { loadReplacement } from "../../modules/return-request/replacement"
import type ReturnRequestModuleService from "../../modules/return-request/service"
import { roundMoney, toNumber } from "../../modules/wallet/utils"
import { REVERSE_LOGISTICS_FEE, RETURN_WINDOW_DAYS } from "../../utils/tax-config"
import { TOTE_SKU } from "../../utils/commerce-rules"

type OrderItem = {
  id: string
  title: string
  variant_title?: string | null
  variant_sku?: string | null
  quantity?: unknown
  /** The quantity is only filled in on the line itself when this is requested too. */
  detail?: { quantity?: unknown } | null
  unit_price: unknown
}

type OrderRecord = {
  id: string
  display_id?: number | null
  customer_id?: string | null
  email?: string | null
  status?: string | null
  discount_total?: unknown
  metadata?: Record<string, unknown> | null
  items?: OrderItem[] | null
}

type Input = {
  customer_id: string
  order_id: string
  type: "return" | "exchange"
  reason: string
  replacement_variant_id?: string
  items: { item_id: string; quantity: number }[]
  // Query results are loosely typed, so they are narrowed below.
  orders: unknown[]
  customers: { id: string; email?: string | null }[]
}

export type ValidatedRequest = {
  items: RequestedItem[]
  /** What the customer paid for the requested items. */
  paid_value: number
  /** The reverse logistics fee a return keeps (0 for damaged or defective); null for an exchange. */
  fee_amount: number | null
  delivered_at: string | null
  /** False when delivery could not be confirmed, so our team reviews the request by hand. */
  delivery_confirmed: boolean
  order_ref: string
  replacement: {
    variant_id: string
    title: string
    price: number
    /** Replacement price less what was paid; positive when the customer pays more. */
    price_difference: number
    /** What the customer pays before the pickup: only the extra price, 0 when there is none. */
    amount_due: number
  } | null
}

function sameEmail(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
}

const NOT_YET = "You can return or exchange an item once it has been delivered."

/**
 * Checks a request against the order it is about, and works out what it is for.
 *
 *  - the order is the customer's, shipped, and not cancelled;
 *  - it was delivered, and the request is inside the 7 days after delivery (when
 *    delivery cannot be confirmed at all the request is still taken, for our
 *    team to check by hand, as before);
 *  - the reason is one of the four on offer;
 *  - the items are on the order, not the free tote, and not already covered by
 *    another open or approved request;
 *  - an exchange names one item, one unit, and a replacement that is on sale and
 *    in stock, and what it costs is read from Medusa.
 */
export const validateReturnRequestStep = createStep(
  "validate-return-request",
  async (input: Input, { container }) => {
    const customer = input.customers[0]
    if (!customer) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Customer was not found")

    const order = input.orders[0] as OrderRecord | undefined
    if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
    if (order.customer_id !== customer.id && !sameEmail(order.email, customer.email)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "That order does not belong to this customer")
    }
    if (order.status === "canceled") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "A cancelled order cannot be returned")
    }
    if (!(RETURN_REASON_CODES as readonly string[]).includes(input.reason)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose a reason for the return or exchange")
    }
    if (input.items.length === 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose at least one item")
    }

    const dispatchService: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [dispatch] = await dispatchService.listOrderDispatches({ order_id: order.id }, { take: 1 })
    const delivery = deliveryStateOf(dispatch ?? null, order.metadata)
    if (delivery.kind === "in_transit" || delivery.kind === "returning") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, NOT_YET, "not_delivered")
    }
    if (delivery.kind === "unknown" && dispatch && ["placed", "dispatching", "dispatch_failed", "cancelling"].includes(dispatch.state)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, NOT_YET, "not_delivered")
    }
    if (delivery.kind === "delivered" && !withinReturnWindow(delivery.at)) {
      const ended = returnWindowEnds(delivery.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Returns and exchanges are open for ${RETURN_WINDOW_DAYS} days after delivery. That window ended on ${ended}.`,
        "window_closed"
      )
    }

    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    const existing = await requestService.listReturnRequests({ order_id: order.id, status: [...OPEN_STATUSES] })
    const alreadyRequested = new Map<string, number>()
    for (const request of existing) {
      for (const item of fromStoredItems(request.items)) {
        alreadyRequested.set(item.item_id, (alreadyRequested.get(item.item_id) ?? 0) + item.quantity)
      }
    }

    const lines = (order.items ?? []).map((item) => ({
      item,
      quantity: toNumber(item.detail?.quantity ?? item.quantity),
      unit_price: toNumber(item.unit_price),
    }))
    const net = paidValues(
      lines.map((line) => ({ item_id: line.item.id, unit_price: line.unit_price, quantity: line.quantity })),
      toNumber(order.discount_total)
    )

    const stored: RequestedItem[] = []
    const seen = new Set<string>()
    for (const wanted of input.items) {
      if (seen.has(wanted.item_id)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Each item can only be listed once")
      seen.add(wanted.item_id)

      const line = lines.find((entry) => entry.item.id === wanted.item_id)
      if (!line) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Item ${wanted.item_id} is not on this order`)
      if (line.unit_price === 0 || line.item.variant_sku === TOTE_SKU) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `"${line.item.title}" is a free gift and cannot be returned or exchanged`)
      }

      const open = line.quantity - (alreadyRequested.get(line.item.id) ?? 0)
      if (!Number.isInteger(wanted.quantity) || wanted.quantity < 1 || wanted.quantity > open) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          open <= 0
            ? `"${line.item.title}" already has a return or exchange request`
            : `You can request at most ${open} of "${line.item.title}"`
        )
      }

      stored.push({
        item_id: line.item.id,
        title: line.item.title,
        quantity: wanted.quantity,
        unit_price: line.unit_price,
        total: paidValueOf(net.get(line.item.id) ?? 0, line.quantity, wanted.quantity),
        variant_title: line.item.variant_title ?? null,
        sku: line.item.variant_sku ?? null,
      })
    }

    const paidValue = roundMoney(stored.reduce((sum, item) => sum + item.total, 0))
    const orderRef = `EYRA-${order.display_id ?? ""}`

    let replacement: ValidatedRequest["replacement"] = null
    if (input.type === "exchange") {
      if (stored.length !== 1 || stored[0].quantity !== 1) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "An exchange is for one item, one unit at a time")
      }
      if (!input.replacement_variant_id) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose the size or design you want instead")
      }
      const found = await loadReplacement(container, input.replacement_variant_id)
      if (!found.ok) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, found.error, "replacement_unavailable")
      const difference = roundMoney(found.replacement.price - paidValue)
      replacement = {
        variant_id: found.replacement.variant_id,
        title: found.replacement.title,
        price: found.replacement.price,
        price_difference: difference,
        amount_due: difference >= 1 ? roundMoney(difference) : 0,
      }
    }

    const result: ValidatedRequest = {
      items: stored,
      paid_value: paidValue,
      // No fee for a damaged or defective item. The fee includes 18% GST, and is shown on the credit note.
      fee_amount: input.type === "return" ? (feeWaivedFor(input.reason) ? 0 : Math.min(REVERSE_LOGISTICS_FEE, paidValue)) : null,
      delivered_at: delivery.kind === "delivered" ? delivery.at.toISOString() : null,
      delivery_confirmed: delivery.kind === "delivered",
      order_ref: orderRef,
      replacement,
    }
    return new StepResponse(result)
  }
)
