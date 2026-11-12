import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../return-request"
import { ORDER_DISPATCH_MODULE } from "./index"
import { CHECKOUT_MARKER } from "./order-integrity"

/**
 * Whether an order is backed by a real checkout and a recorded payment, so it
 * may be shipped. An order can exist without either after a crash part-way
 * through Medusa's cart completion: the order row is written before it is
 * linked to its cart and before the payment is authorized. Such an order must
 * never be shipped. Pure judge first, loader below.
 */

const PAISA = 0.005

export type StandingOrder = {
  id: string
  total: number
  metadata: Record<string, unknown> | null
  /** The order is linked to the cart it was completed from. */
  has_cart: boolean
  /** For a replacement order: the exchange request names this order as its replacement. */
  replacement_linked: boolean
  /** Staff allowed this order to ship without a checkout (see DispatchOverride). */
  override: boolean
  payment_collections: {
    status: string | null
    amount: number
    payments: { amount: number; canceled_at: unknown; provider_id: string | null }[]
  }[]
}

export type PaymentStanding =
  | { ok: true; kind: "paid" | "no_payment_due" | "replacement" | "override" }
  | {
      ok: false
      reason: "no_cart" | "no_payment_record" | "payment_short" | "replacement_unlinked"
    }

export function judgePaymentStanding(order: StandingOrder): PaymentStanding {
  // Exchange replacements are made by the backend after the difference is paid by payment link.
  if (order.metadata?.replacement_for_order) {
    return order.replacement_linked ? { ok: true, kind: "replacement" } : { ok: false, reason: "replacement_unlinked" }
  }
  // A staff override stands in for the checkout link, but never for an order a
  // checkout started (those are leftovers, see order-integrity) or for payment.
  const fromCheckout = typeof order.metadata?.[CHECKOUT_MARKER] === "string"
  const overridden = !order.has_cart && order.override && !fromCheckout
  if (!order.has_cart && !overridden) return { ok: false, reason: "no_cart" }

  const collections = order.payment_collections.filter((c) => c.status !== "canceled")
  if (!collections.length) {
    // An unreadable total is never taken as "nothing due".
    if (!Number.isFinite(Number(order.total))) return { ok: false, reason: "no_payment_record" }
    // Wallet credit covered everything: Medusa needs no payment.
    if (Number(order.total) > PAISA) return { ok: false, reason: "no_payment_record" }
    return { ok: true, kind: overridden ? "override" : "no_payment_due" }
  }
  const due = collections.reduce((sum, c) => sum + Number(c.amount), 0)
  if (due <= PAISA) return { ok: true, kind: overridden ? "override" : "no_payment_due" }
  const paid = collections
    .flatMap((c) => c.payments)
    .filter((p) => !p.canceled_at)
    .reduce((sum, p) => sum + Number(p.amount), 0)
  if (paid + PAISA >= due) return { ok: true, kind: overridden ? "override" : "paid" }
  return { ok: false, reason: paid > 0 ? "payment_short" : "no_payment_record" }
}

export const STANDING_MESSAGES: Record<string, string> = {
  no_cart: "This order is not linked to a completed checkout (it may be left over from an interrupted checkout).",
  no_payment_record: "No payment is recorded for this order yet.",
  payment_short: "The recorded payment is less than the amount due.",
  replacement_unlinked: "This replacement order is not linked to its exchange request.",
}

const num = (value: unknown) => Number((value as { numeric?: unknown })?.numeric ?? value)

/**
 * What the standing reads from an order. Without the line quantities (in each
 * line's detail) and the shipping and credit lines, Medusa works the order's
 * total out as 0, which would make an unpaid order look like it owes nothing.
 */
export const STANDING_ORDER_FIELDS = [
  "id",
  "total",
  "metadata",
  "items.*",
  "items.detail.quantity",
  "items.adjustments.*",
  "shipping_methods.*",
  "shipping_methods.adjustments.*",
  "credit_lines.*",
  "payment_collections.status",
  "payment_collections.amount",
  "payment_collections.payments.amount",
  "payment_collections.payments.canceled_at",
  "payment_collections.payments.provider_id",
]

export async function loadPaymentStanding(container: MedusaContainer, orderId: string): Promise<PaymentStanding & { order_found: boolean }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: STANDING_ORDER_FIELDS,
    filters: { id: orderId },
  })
  const order = data[0] as any
  if (!order) return { ok: false, reason: "no_cart", order_found: false }

  const { data: links } = await query.graph({ entity: "order_cart", fields: ["cart_id"], filters: { order_id: orderId } })

  let replacementLinked = false
  if (order.metadata?.replacement_for_order) {
    const service = container.resolve(RETURN_REQUEST_MODULE) as {
      listReturnRequests: (filters: Record<string, unknown>, config?: Record<string, unknown>) => Promise<{ id: string }[]>
    }
    const requests = await service.listReturnRequests({ replacement_order_id: orderId }, { take: 1 })
    replacementLinked = requests.length > 0
  }

  const dispatch = container.resolve(ORDER_DISPATCH_MODULE) as {
    listDispatchOverrides: (filters: Record<string, unknown>, config?: Record<string, unknown>) => Promise<{ id: string }[]>
  }
  const overrides = await dispatch.listDispatchOverrides({ order_id: orderId, revoked_at: null }, { take: 1 })

  const standing = judgePaymentStanding({
    id: order.id,
    total: num(order.total),
    metadata: order.metadata ?? null,
    has_cart: links.length > 0,
    replacement_linked: replacementLinked,
    override: overrides.length > 0,
    payment_collections: (order.payment_collections ?? []).filter(Boolean).map((c: any) => ({
      status: c.status ?? null,
      amount: num(c.amount),
      payments: (c.payments ?? []).filter(Boolean).map((p: any) => ({
        amount: num(p.amount),
        canceled_at: p.canceled_at ?? null,
        provider_id: p.provider_id ?? null,
      })),
    })),
  })
  return { ...standing, order_found: true }
}
