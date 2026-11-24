import type { GatewayAttempt, GatewayPaymentStatus } from "./types"

/** Razorpay's own records and how they map onto the shared attempt shape. Pure. */

export type RazorpayOrder = {
  id: string
  amount: number
  currency: string
  status?: string
  amount_paid?: number
  notes?: Record<string, unknown> | null
}

export type RazorpayPayment = {
  id: string
  order_id: string | null
  amount: number
  currency: string
  status: string
}

const STATUSES: GatewayPaymentStatus[] = ["captured", "authorized", "failed", "refunded"]

/** The Razorpay order id the plugin keeps on a payment session. */
export function sessionRazorpayOrderId(session: { data?: Record<string, unknown> | null } | null | undefined): string | null {
  const order = (session?.data as { razorpayOrder?: { id?: unknown } } | null | undefined)?.razorpayOrder
  return typeof order?.id === "string" ? order.id : null
}

/** The Razorpay order amount the plugin keeps on a payment session, in paise. */
export function sessionRazorpayAmount(session: { data?: Record<string, unknown> | null } | null | undefined): number {
  const order = (session?.data as { razorpayOrder?: { amount?: unknown } } | null | undefined)?.razorpayOrder
  return Number(order?.amount)
}

/** A Razorpay order and its payments as a shared attempt. Razorpay amounts are already in paise. */
export function razorpayAttempt(order: RazorpayOrder, payments: RazorpayPayment[]): GatewayAttempt {
  return {
    ref: order.id,
    amount_paise: Number(order.amount),
    currency: order.currency,
    payments: payments.map((payment) => ({
      id: payment.id,
      attempt_ref: payment.order_id,
      amount_paise: Number(payment.amount),
      currency: payment.currency,
      status: (STATUSES as string[]).includes(payment.status) ? (payment.status as GatewayPaymentStatus) : "pending",
    })),
    raw: order,
  }
}
