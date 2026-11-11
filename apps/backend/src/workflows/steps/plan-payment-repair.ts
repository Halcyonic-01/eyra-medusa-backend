import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { fetchRazorpayOrderPayments } from "../../modules/payment-snapshot/razorpay-api"
import {
  RAZORPAY_PROVIDER_ID,
  paidTowardsOrder,
  sessionRazorpayAmount,
  sessionRazorpayOrderId,
  toPaise,
  type SessionLike,
} from "../../modules/payment-snapshot/rules"

const COD_PROVIDER_ID = "pp_system_default"
const PROCESSABLE = ["pending", "requires_more", "authorized"]

export type PaymentRepairPlan =
  | { action: "authorize"; session_id: string; provider_id: string }
  | { action: "unpaid"; reason: string }
  | { action: "none"; reason: string }

/**
 * Decides how to repair an order that was placed but has no payment record,
 * which happens when the server stops between Medusa creating the order and
 * authorizing its payment. A Razorpay payment is only recorded once Razorpay
 * itself confirms its order was paid in full for exactly the session's amount.
 * Throws when Razorpay cannot be asked, so the next run tries again.
 */
export const planPaymentRepairStep = createStep(
  "plan-payment-repair",
  async (input: { order_id: string }, { container }) => {
    return new StepResponse(await decidePaymentRepair(container, input.order_id))
  }
)

async function decidePaymentRepair(container: MedusaContainer, orderId: string): Promise<PaymentRepairPlan> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const plan = (value: PaymentRepairPlan) => value
  const input = { order_id: orderId }

  const { data: links } = await query.graph({ entity: "order_cart", fields: ["cart_id"], filters: { order_id: input.order_id } })
  if (!links.length) return plan({ action: "none", reason: "no_cart" })

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "payment_collections.id",
      "payment_collections.status",
      "payment_collections.amount",
      "payment_collections.payments.id",
      "payment_collections.payments.canceled_at",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.status",
      "payment_collections.payment_sessions.amount",
      "payment_collections.payment_sessions.data",
    ],
    filters: { id: input.order_id },
  })
  const order = data[0] as any
  if (!order || order.status === "canceled") return plan({ action: "none", reason: "not_open" })

  const collections = (order.payment_collections ?? []).filter((c: any) => c && c.status !== "canceled" && toPaise(c.amount) > 0)
  if (!collections.length) return plan({ action: "none", reason: "no_payment_due" })
  if (collections.some((c: any) => (c.payments ?? []).some((p: any) => p && !p.canceled_at))) {
    return plan({ action: "none", reason: "has_payment" })
  }

  const collection = collections[0]
  const session = ((collection.payment_sessions ?? []) as SessionLike[]).find((s) => s && s.status && PROCESSABLE.includes(s.status))
  if (!session) return plan({ action: "unpaid", reason: "no_payment_session" })
  if (toPaise(session.amount) !== toPaise(collection.amount)) return plan({ action: "unpaid", reason: "amount_mismatch" })

  if (session.provider_id === COD_PROVIDER_ID) {
    // Cash on Delivery: the customer confirmed the order; nothing is collected up front.
    return plan({ action: "authorize", session_id: session.id, provider_id: COD_PROVIDER_ID })
  }
  if (session.provider_id !== RAZORPAY_PROVIDER_ID) return plan({ action: "unpaid", reason: "unsupported_provider" })

  const razorpayOrderId = sessionRazorpayOrderId(session)
  if (!razorpayOrderId) return plan({ action: "unpaid", reason: "no_razorpay_order" })
  const { order: razorpayOrder, payments } = await fetchRazorpayOrderPayments(razorpayOrderId)
  const expected = toPaise(session.amount)
  if (
    !razorpayOrder ||
    Number(razorpayOrder.amount) !== expected ||
    sessionRazorpayAmount(session) !== expected ||
    paidTowardsOrder(razorpayOrder, payments) !== expected
  ) {
    return plan({ action: "unpaid", reason: "not_paid_at_razorpay" })
  }
  return plan({ action: "authorize", session_id: session.id, provider_id: RAZORPAY_PROVIDER_ID })
}
