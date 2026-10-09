import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { WALLET_CREDIT_LINE_REFERENCE, roundMoney } from "../wallet/utils"
import type { CancellationContext } from "./cancellation"

type Money = number | string | { value?: string | number } | null | undefined

/** Reads a money amount, which Medusa returns as a number or as a BigNumber object. */
function num(value: Money): number {
  if (value !== null && typeof value === "object") {
    const direct = Number(value)
    return roundMoney(Number.isFinite(direct) ? direct : Number(value.value))
  }
  return roundMoney(Number(value ?? 0))
}

type OrderRow = {
  id: string
  display_id: number
  customer_id: string | null
  email: string | null
  status: string
  created_at: string | Date
  total?: Money
  metadata?: Record<string, unknown> | null
  credit_lines?: { amount?: Money; reference?: string | null }[]
  fulfillments?: { id: string; canceled_at?: string | Date | null }[]
  payment_collections?: {
    payments?: {
      id: string
      provider_id?: string | null
      data?: { razorpayOrder?: { id?: string } } | null
      captures?: { amount?: Money }[]
      refunds?: { amount?: Money }[]
    }[]
  }[]
}

/**
 * Reads what a cancellation needs to know about an order: what was paid
 * online and not yet refunded, what wallet credit it used, and who owns it.
 * Returns null when there is no such order.
 */
export async function loadCancellationContext(
  container: MedusaContainer,
  orderId: string
): Promise<CancellationContext | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "customer_id",
      "email",
      "status",
      "created_at",
      "total",
      "metadata",
      "credit_lines.amount",
      "credit_lines.reference",
      "fulfillments.id",
      "fulfillments.canceled_at",
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.data",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.refunds.amount",
    ],
    filters: { id: orderId },
  })
  const order = data[0] as unknown as OrderRow | undefined
  if (!order) {
    return null
  }

  const walletUsed = (order.credit_lines ?? [])
    .filter((line) => line.reference === WALLET_CREDIT_LINE_REFERENCE)
    .reduce((sum, line) => sum + num(line.amount), 0)

  const online = (order.payment_collections ?? [])
    .flatMap((collection) => collection.payments ?? [])
    .filter((payment) => (payment.provider_id ?? "").includes("razorpay"))

  const onlinePayments = online
    .map((payment) => {
      const captured = (payment.captures ?? []).reduce((sum, capture) => sum + num(capture.amount), 0)
      const refunded = (payment.refunds ?? []).reduce((sum, refund) => sum + num(refund.amount), 0)
      return { payment_id: payment.id, refundable: roundMoney(captured - refunded), captured }
    })

  const razorpayPaymentId =
    typeof order.metadata?.razorpay_payment_id === "string" ? order.metadata.razorpay_payment_id : null
  const razorpayOrderId =
    typeof order.metadata?.razorpay_order_id === "string"
      ? order.metadata.razorpay_order_id
      : online.map((payment) => payment.data?.razorpayOrder?.id).find((id) => typeof id === "string") ?? null

  return {
    order_id: order.id,
    display_id: Number(order.display_id),
    customer_id: order.customer_id,
    email: order.email,
    order_status: order.status,
    placed_at: new Date(order.created_at).toISOString(),
    total: num(order.total),
    wallet_used: roundMoney(walletUsed),
    online_payments: onlinePayments
      .filter((payment) => payment.refundable > 0)
      .map(({ payment_id, refundable }) => ({ payment_id, refundable })),
    paid_online: roundMoney(onlinePayments.reduce((sum, payment) => sum + Math.max(payment.refundable, 0), 0)),
    has_unsettled_online: onlinePayments.some((payment) => payment.captured <= 0),
    razorpay_payment_id: razorpayPaymentId,
    razorpay_order_id: razorpayOrderId,
    has_razorpay_payment: online.length > 0,
    has_active_fulfillment: (order.fulfillments ?? []).some((fulfillment) => !fulfillment.canceled_at),
  }
}
