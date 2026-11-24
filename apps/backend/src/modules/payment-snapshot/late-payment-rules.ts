import { ownPayments, type GatewayAttempt, type GatewayPayment } from "./gateways/types"
import {
  attemptAmountPaise,
  attemptRef,
  sameLines,
  snapshotLines,
  toPaise,
  type CartLike,
  type PaymentSnapshotRecord,
  type SessionLike,
} from "./rules"

/**
 * What to do about an online payment attempt that is no longer the cart's
 * current one. Pure, so every case is unit tested; nothing here knows a
 * provider.
 *
 * Medusa deletes a payment session when a newer one replaces it, but the
 * attempt it opened can still be paid (a slow UPI approval, a second tab).
 * Exactly one payment may become the cart's order; every other payment taken
 * for the cart goes back to the customer. A payment can only be put back on
 * the cart through a session of the same provider.
 */

export type AttemptFacts = {
  snapshot: Pick<
    PaymentSnapshotRecord,
    "cart_id" | "provider_id" | "provider_ref" | "razorpay_order_id" | "provider_amount_paise" | "razorpay_amount_paise" | "amount_paise" | "currency_code" | "lines"
  >
  /** The attempt as its provider reports it, or null when the provider does not know it. */
  attempt: GatewayAttempt | null
  cart: CartLike & { completed_at?: unknown }
  /** The session Medusa would complete the cart with, if any. */
  currentSession: SessionLike | null
  /** The attempt the current session pays (null for COD or no session). */
  currentSessionRef: string | null
  /** Paid towards the current session's own attempt, in paise (0 when it has none). */
  currentPaidPaise: number
  /** The order the cart became, with the attempts its payments came from. */
  order: { id: string; attempt_refs: string[] } | null
}

export type LateDecision =
  | { action: "none"; reason: "not_paid" | "authorized_only" | "in_order" | "current_attempt" | "order_pending" }
  | { action: "recover" }
  | { action: "wait"; reason: "other_attempt_paid" }
  | { action: "refund"; reason: "ordered_otherwise" | "cart_changed" | "checkout_changed" | "partial_payment"; payments: GatewayPayment[] }

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
    attemptAmountPaise(snapshot) === snapshot.amount_paise &&
    sameLines(snapshotLines(cart), snapshot.lines)
  )
}

export function judgeLateAttempt(facts: AttemptFacts): LateDecision {
  const { snapshot, attempt, currentSession, order } = facts
  const ref = attemptRef(snapshot)
  const mine = attempt && attempt.ref === ref && attempt.currency.toLowerCase() === snapshot.currency_code.toLowerCase() ? ownPayments(attempt) : []
  const captured = mine.filter((payment) => payment.status === "captured")
  if (!captured.length) {
    // The provider either captures an authorized payment shortly or gives it back on its own.
    return mine.some((payment) => payment.status === "authorized")
      ? { action: "none", reason: "authorized_only" }
      : { action: "none", reason: "not_paid" }
  }

  if (order) {
    if (order.attempt_refs.includes(ref)) return { action: "none", reason: "in_order" }
    return { action: "refund", reason: "ordered_otherwise", payments: captured }
  }
  // Completed but not linked yet: an order is being written right now.
  if (facts.cart.completed_at) return { action: "none", reason: "order_pending" }

  if (currentSession && currentSession.provider_id === snapshot.provider_id && facts.currentSessionRef === ref) {
    return { action: "none", reason: "current_attempt" }
  }

  const paid = captured.reduce((sum, payment) => sum + Number(payment.amount_paise), 0)
  if (paid !== attemptAmountPaise(snapshot) || (attempt && attempt.amount_paise !== attemptAmountPaise(snapshot))) {
    return { action: "refund", reason: "partial_payment", payments: captured }
  }
  // Cash on Delivery now, no payment, or another provider: this payment cannot be put on the cart.
  if (!currentSession || !facts.currentSessionRef || currentSession.provider_id !== snapshot.provider_id) {
    return { action: "refund", reason: "checkout_changed", payments: captured }
  }
  // The current attempt was paid too: it becomes the order, and this one is refunded once it has.
  if (facts.currentPaidPaise > 0 || currentSession.status === "authorized") return { action: "wait", reason: "other_attempt_paid" }
  if (!attemptMatchesCart(facts)) return { action: "refund", reason: "cart_changed", payments: captured }
  return { action: "recover" }
}
