import { toNumber } from "../../utils/commerce-rules"
import { RAZORPAY_PROVIDER_ID } from "./gateways/ids"
import { sessionRazorpayAmount, sessionRazorpayOrderId, type RazorpayOrder, type RazorpayPayment } from "./gateways/razorpay-shape"
import { paidTowardsAttempt, type GatewayAttempt } from "./gateways/types"

/**
 * Rules for honouring the price a customer agreed to when they opened an
 * online payment attempt. Pure, so every case is unit tested. Nothing here
 * knows a provider: the caller passes the attempt a session pays (its ref and
 * amount, from the provider's gateway) and what the provider says was paid.
 *
 * The idea: a snapshot is only written by the backend, right after the cart was
 * repriced to today's prices. If the provider later confirms that exact attempt
 * was paid in full, and the cart is still exactly what was snapshotted, the
 * order is placed at the snapshotted price even if a sale ended in between.
 * Anything else (no snapshot, a new attempt, a changed cart, a short or failed
 * payment) falls back to the normal rule: lines must be at today's price.
 */

export { RAZORPAY_PROVIDER_ID, sessionRazorpayAmount, sessionRazorpayOrderId }
export type { RazorpayOrder, RazorpayPayment }

export type SnapshotLine = {
  id: string
  variant_id: string | null
  quantity: number
  unit_price_paise: number
}

/**
 * One attempt as recorded. `provider_ref` and `provider_amount_paise` are the
 * attempt; the razorpay_* columns are the same values on Razorpay rows, kept
 * for rows written before the provider columns existed.
 */
export type PaymentSnapshotRecord = {
  cart_id: string
  payment_session_id: string
  provider_id: string
  provider_ref?: string | null
  provider_amount_paise?: number | null
  razorpay_order_id?: string | null
  razorpay_amount_paise?: number | null
  currency_code: string
  amount_paise: number
  lines: SnapshotLine[]
}

export type CartLineLike = {
  id: string
  variant_id?: string | null
  quantity?: unknown
  unit_price?: unknown
}

export type CartLike = {
  id: string
  currency_code?: string | null
  total?: unknown
  items?: (CartLineLike | null)[] | null
}

export type SessionLike = {
  id: string
  provider_id?: string | null
  status?: string | null
  amount?: unknown
  currency_code?: string | null
  data?: Record<string, unknown> | null
}

/** The attempt a session pays, as its provider's gateway reads it from the session. */
export type SessionBinding = { ref: string | null; attempt_amount_paise: number }

export type SnapshotVerdict =
  | { honoured: true }
  | {
      honoured: false
      reason: "no_snapshot" | "session_changed" | "cart_changed" | "amount_mismatch" | "not_paid"
    }

/** Rupees (number, text or BigNumber) to whole paise. NaN stays NaN. */
export function toPaise(value: unknown): number {
  const rupees = toNumber(value)
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : Number.NaN
}

/** The attempt a snapshot records. Rows from before the provider columns only have the Razorpay ones. */
export function attemptRef(snapshot: Pick<PaymentSnapshotRecord, "provider_ref" | "razorpay_order_id">): string {
  return snapshot.provider_ref ?? snapshot.razorpay_order_id ?? ""
}

/** What the recorded attempt asks for, in paise. */
export function attemptAmountPaise(snapshot: Pick<PaymentSnapshotRecord, "provider_amount_paise" | "razorpay_amount_paise">): number {
  return Number(snapshot.provider_amount_paise ?? snapshot.razorpay_amount_paise ?? Number.NaN)
}

/** Every line on the cart, as the snapshot stores it: sorted, in paise. */
export function snapshotLines(cart: CartLike): SnapshotLine[] {
  return (cart.items ?? [])
    .filter((line): line is CartLineLike => Boolean(line))
    .map((line) => ({
      id: line.id,
      variant_id: line.variant_id ?? null,
      quantity: toNumber(line.quantity),
      unit_price_paise: toPaise(line.unit_price),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function sameLines(a: SnapshotLine[], b: SnapshotLine[]): boolean {
  if (a.length !== b.length) return false
  return a.every((line, index) => {
    const other = b[index]
    return (
      line.id === other.id &&
      line.variant_id === other.variant_id &&
      line.quantity === other.quantity &&
      line.unit_price_paise === other.unit_price_paise
    )
  })
}

/**
 * Builds the snapshot for a freshly opened attempt, or explains why it cannot
 * be trusted. The session amount, the cart total and the provider's attempt
 * must all agree to the paisa, or no snapshot is written. `binding` is null
 * when the session's provider has no gateway (not an online payment).
 */
export function buildSnapshot(
  cart: CartLike,
  session: SessionLike,
  paymentCollectionId: string,
  binding: SessionBinding | null
): { ok: true; snapshot: PaymentSnapshotRecord & { payment_collection_id: string; provider_ref: string; provider_amount_paise: number } } | { ok: false; message: string } {
  if (!binding?.ref || !session.provider_id) {
    return { ok: false, message: "The payment session is not an online payment attempt." }
  }
  const amount = toPaise(session.amount)
  const total = toPaise(cart.total)
  const attemptAmount = binding.attempt_amount_paise
  if (!Number.isFinite(amount) || amount <= 0 || amount !== total || attemptAmount !== amount) {
    return {
      ok: false,
      message: `The payment amount does not match the cart (cart ${total}, session ${amount}, provider ${attemptAmount} paise).`,
    }
  }
  const currency = (session.currency_code ?? cart.currency_code ?? "").toLowerCase()
  if (!currency || currency !== (cart.currency_code ?? "").toLowerCase()) {
    return { ok: false, message: "The payment currency does not match the cart." }
  }
  const razorpay = session.provider_id === RAZORPAY_PROVIDER_ID
  return {
    ok: true,
    snapshot: {
      cart_id: cart.id,
      payment_collection_id: paymentCollectionId,
      payment_session_id: session.id,
      provider_id: session.provider_id,
      provider_ref: binding.ref,
      provider_amount_paise: attemptAmount,
      // Still written for Razorpay, so a rollback to code that reads only these keeps working.
      razorpay_order_id: razorpay ? binding.ref : null,
      razorpay_amount_paise: razorpay ? attemptAmount : null,
      currency_code: currency,
      amount_paise: amount,
      lines: snapshotLines(cart),
    },
  }
}

/**
 * Whether the cart can still be checked against the snapshot, before asking
 * the provider anything: same session, same attempt, same lines, same amount.
 */
export function snapshotMatchesCart(
  snapshot: PaymentSnapshotRecord | null | undefined,
  cart: CartLike,
  session: SessionLike | null | undefined,
  sessionRef: string | null
): SnapshotVerdict {
  if (!snapshot) return { honoured: false, reason: "no_snapshot" }
  if (
    !session ||
    session.provider_id !== snapshot.provider_id ||
    session.id !== snapshot.payment_session_id ||
    !sessionRef ||
    sessionRef !== attemptRef(snapshot) ||
    snapshot.cart_id !== cart.id
  ) {
    return { honoured: false, reason: "session_changed" }
  }
  if (
    toPaise(session.amount) !== snapshot.amount_paise ||
    toPaise(cart.total) !== snapshot.amount_paise ||
    (cart.currency_code ?? "").toLowerCase() !== snapshot.currency_code
  ) {
    return { honoured: false, reason: "amount_mismatch" }
  }
  if (!sameLines(snapshotLines(cart), snapshot.lines)) {
    return { honoured: false, reason: "cart_changed" }
  }
  return { honoured: true }
}

/**
 * The full decision: the cart still matches its snapshot, and the provider
 * confirms the snapshotted attempt for the snapshotted amount was paid in full.
 */
export function judgePaidSnapshot(input: {
  snapshot: PaymentSnapshotRecord | null | undefined
  cart: CartLike
  session: SessionLike | null | undefined
  sessionRef: string | null
  attempt: GatewayAttempt | null
}): SnapshotVerdict {
  const local = snapshotMatchesCart(input.snapshot, input.cart, input.session, input.sessionRef)
  if (!local.honoured) return local
  const snapshot = input.snapshot as PaymentSnapshotRecord
  const attempt = input.attempt
  if (
    !attempt ||
    attempt.ref !== attemptRef(snapshot) ||
    attempt.amount_paise !== attemptAmountPaise(snapshot) ||
    attempt.currency.toLowerCase() !== snapshot.currency_code
  ) {
    return { honoured: false, reason: "amount_mismatch" }
  }
  if (paidTowardsAttempt(attempt) !== attempt.amount_paise) {
    return { honoured: false, reason: "not_paid" }
  }
  return { honoured: true }
}
