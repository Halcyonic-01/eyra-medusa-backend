import {
  RAZORPAY_PROVIDER_ID,
  sameLines,
  sessionRazorpayOrderId,
  snapshotLines,
  toPaise,
  type CartLike,
  type PaymentSnapshotRecord,
  type RazorpayOrder,
  type RazorpayPayment,
  type SessionLike,
} from "./rules"

/**
 * What to do about a Razorpay attempt that is no longer the cart's current
 * one. Pure, so every case is unit tested.
 *
 * Medusa deletes a payment session when a newer one replaces it, but the
 * Razorpay order it opened can still be paid (a slow UPI approval, a second
 * tab). Exactly one payment may become the cart's order; every other payment
 * taken for the cart goes back to the customer.
 */

export type AttemptFacts = {
  snapshot: Pick<PaymentSnapshotRecord, "cart_id" | "razorpay_order_id" | "razorpay_amount_paise" | "amount_paise" | "currency_code" | "lines">
  razorpayOrder: RazorpayOrder | null
  payments: RazorpayPayment[]
  cart: CartLike & { completed_at?: unknown }
  /** The session Medusa would complete the cart with, if any. */
  currentSession: SessionLike | null
  /** Paid at Razorpay towards the current session's own Razorpay order, in paise (0 when it has none). */
  currentPaidPaise: number
  /** The order the cart became, with the Razorpay orders its payments came from. */
  order: { id: string; razorpay_order_ids: string[] } | null
}

export type LateDecision =
  | { action: "none"; reason: "not_paid" | "authorized_only" | "in_order" | "current_attempt" | "order_pending" }
  | { action: "recover" }
  | { action: "wait"; reason: "other_attempt_paid" }
  | { action: "refund"; reason: "ordered_otherwise" | "cart_changed" | "not_razorpay_checkout" | "partial_payment"; payments: RazorpayPayment[] }

function own(order: RazorpayOrder | null, payments: RazorpayPayment[], razorpayOrderId: string, currency: string) {
  return payments.filter(
    (payment) =>
      payment.order_id === razorpayOrderId &&
      (!order || order.id === razorpayOrderId) &&
      payment.currency.toLowerCase() === currency.toLowerCase()
  )
}

/** The cart still is exactly what the attempt was opened for, and the current session asks for the same amount. */
export function attemptMatchesCart(facts: Pick<AttemptFacts, "snapshot" | "cart" | "currentSession">): boolean {
  const { snapshot, cart, currentSession } = facts
  if (!currentSession) return false
  const currency = snapshot.currency_code.toLowerCase()
  return (
    (cart.currency_code ?? "").toLowerCase() === currency &&
    (currentSession.currency_code ?? currency).toLowerCase() === currency &&
    toPaise(cart.total) === snapshot.amount_paise &&
    toPaise(currentSession.amount) === snapshot.amount_paise &&
    snapshot.razorpay_amount_paise === snapshot.amount_paise &&
    sameLines(snapshotLines(cart), snapshot.lines)
  )
}

export function judgeLateAttempt(facts: AttemptFacts): LateDecision {
  const { snapshot, razorpayOrder, currentSession, order } = facts
  const mine = own(razorpayOrder, facts.payments, snapshot.razorpay_order_id, snapshot.currency_code)
  const captured = mine.filter((payment) => payment.status === "captured")
  if (!captured.length) {
    // Razorpay either captures an authorized payment shortly or gives it back on its own.
    return mine.some((payment) => payment.status === "authorized")
      ? { action: "none", reason: "authorized_only" }
      : { action: "none", reason: "not_paid" }
  }

  if (order) {
    if (order.razorpay_order_ids.includes(snapshot.razorpay_order_id)) return { action: "none", reason: "in_order" }
    return { action: "refund", reason: "ordered_otherwise", payments: captured }
  }
  // Completed but not linked yet: an order is being written right now.
  if (facts.cart.completed_at) return { action: "none", reason: "order_pending" }

  if (currentSession && sessionRazorpayOrderId(currentSession) === snapshot.razorpay_order_id) {
    return { action: "none", reason: "current_attempt" }
  }

  const paid = captured.reduce((sum, payment) => sum + Number(payment.amount), 0)
  if (paid !== snapshot.razorpay_amount_paise || (razorpayOrder && Number(razorpayOrder.amount) !== snapshot.razorpay_amount_paise)) {
    return { action: "refund", reason: "partial_payment", payments: captured }
  }
  if (!currentSession || currentSession.provider_id !== RAZORPAY_PROVIDER_ID) {
    return { action: "refund", reason: "not_razorpay_checkout", payments: captured }
  }
  // The current attempt was paid too: it becomes the order, and this one is refunded once it has.
  if (facts.currentPaidPaise > 0 || currentSession.status === "authorized") return { action: "wait", reason: "other_attempt_paid" }
  if (!attemptMatchesCart(facts)) return { action: "refund", reason: "cart_changed", payments: captured }
  return { action: "recover" }
}
