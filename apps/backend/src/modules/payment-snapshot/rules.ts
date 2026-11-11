import { toNumber } from "../../utils/commerce-rules"

/**
 * Rules for honouring the price a customer agreed to when they opened a
 * Razorpay payment. Pure, so every case is unit tested.
 *
 * The idea: a snapshot is only written by the backend, right after the cart was
 * repriced to today's prices. If Razorpay later confirms that exact order was
 * paid in full, and the cart is still exactly what was snapshotted, the order is
 * placed at the snapshotted price even if a sale ended in between. Anything else
 * (no snapshot, a new attempt, a changed cart, a short or failed payment) falls
 * back to the normal rule: lines must be at today's price.
 */

export const RAZORPAY_PROVIDER_ID = "pp_razorpay_razorpay"

/** Razorpay payment states that mean the money was taken. */
const PAID_STATES = ["captured", "authorized"]

export type SnapshotLine = {
  id: string
  variant_id: string | null
  quantity: number
  unit_price_paise: number
}

export type PaymentSnapshotRecord = {
  cart_id: string
  payment_session_id: string
  razorpay_order_id: string
  currency_code: string
  amount_paise: number
  razorpay_amount_paise: number
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

export type RazorpayOrder = {
  id: string
  amount: number
  currency: string
  status?: string
  amount_paid?: number
}

export type RazorpayPayment = {
  id: string
  order_id: string | null
  amount: number
  currency: string
  status: string
}

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

/** The Razorpay order id the plugin keeps on a payment session. */
export function sessionRazorpayOrderId(session: SessionLike | null | undefined): string | null {
  const order = (session?.data as { razorpayOrder?: { id?: unknown } } | null | undefined)?.razorpayOrder
  return typeof order?.id === "string" ? order.id : null
}

/** The Razorpay order amount the plugin keeps on a payment session, in paise. */
export function sessionRazorpayAmount(session: SessionLike | null | undefined): number {
  const order = (session?.data as { razorpayOrder?: { amount?: unknown } } | null | undefined)?.razorpayOrder
  return Number(order?.amount)
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

function sameLines(a: SnapshotLine[], b: SnapshotLine[]): boolean {
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
 * Builds the snapshot for a freshly opened Razorpay session, or explains why it
 * cannot be trusted. The session amount, the cart total and the Razorpay order
 * must all agree to the paisa, or no snapshot is written.
 */
export function buildSnapshot(
  cart: CartLike,
  session: SessionLike,
  paymentCollectionId: string
): { ok: true; snapshot: PaymentSnapshotRecord & { payment_collection_id: string; provider_id: string } } | { ok: false; message: string } {
  const razorpayOrderId = sessionRazorpayOrderId(session)
  if (session.provider_id !== RAZORPAY_PROVIDER_ID || !razorpayOrderId) {
    return { ok: false, message: "The payment session is not a Razorpay payment." }
  }
  const amount = toPaise(session.amount)
  const total = toPaise(cart.total)
  const razorpayAmount = sessionRazorpayAmount(session)
  if (!Number.isFinite(amount) || amount <= 0 || amount !== total || razorpayAmount !== amount) {
    return {
      ok: false,
      message: `The payment amount does not match the cart (cart ${total}, session ${amount}, Razorpay ${razorpayAmount} paise).`,
    }
  }
  const currency = (session.currency_code ?? cart.currency_code ?? "").toLowerCase()
  if (!currency || currency !== (cart.currency_code ?? "").toLowerCase()) {
    return { ok: false, message: "The payment currency does not match the cart." }
  }
  return {
    ok: true,
    snapshot: {
      cart_id: cart.id,
      payment_collection_id: paymentCollectionId,
      payment_session_id: session.id,
      provider_id: RAZORPAY_PROVIDER_ID,
      razorpay_order_id: razorpayOrderId,
      currency_code: currency,
      amount_paise: amount,
      razorpay_amount_paise: razorpayAmount,
      lines: snapshotLines(cart),
    },
  }
}

/** What Razorpay itself says was paid towards the order, in paise. Only verified Razorpay data counts. */
export function paidTowardsOrder(order: RazorpayOrder, payments: RazorpayPayment[]): number {
  return payments
    .filter(
      (payment) =>
        payment.order_id === order.id &&
        PAID_STATES.includes(payment.status) &&
        payment.currency.toUpperCase() === order.currency.toUpperCase()
    )
    .reduce((sum, payment) => sum + Number(payment.amount), 0)
}

/**
 * Whether the cart can still be checked against the snapshot, before asking
 * Razorpay anything: same session, same Razorpay order, same lines, same amount.
 */
export function snapshotMatchesCart(
  snapshot: PaymentSnapshotRecord | null | undefined,
  cart: CartLike,
  session: SessionLike | null | undefined
): SnapshotVerdict {
  if (!snapshot) return { honoured: false, reason: "no_snapshot" }
  if (
    !session ||
    session.provider_id !== RAZORPAY_PROVIDER_ID ||
    session.id !== snapshot.payment_session_id ||
    sessionRazorpayOrderId(session) !== snapshot.razorpay_order_id ||
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
 * The full decision: the cart still matches its snapshot, and Razorpay confirms
 * the snapshotted order for the snapshotted amount was paid in full.
 */
export function judgePaidSnapshot(input: {
  snapshot: PaymentSnapshotRecord | null | undefined
  cart: CartLike
  session: SessionLike | null | undefined
  razorpayOrder: RazorpayOrder | null
  razorpayPayments: RazorpayPayment[]
}): SnapshotVerdict {
  const local = snapshotMatchesCart(input.snapshot, input.cart, input.session)
  if (!local.honoured) return local
  const snapshot = input.snapshot as PaymentSnapshotRecord
  const order = input.razorpayOrder
  if (
    !order ||
    order.id !== snapshot.razorpay_order_id ||
    Number(order.amount) !== snapshot.razorpay_amount_paise ||
    order.currency.toLowerCase() !== snapshot.currency_code
  ) {
    return { honoured: false, reason: "amount_mismatch" }
  }
  if (paidTowardsOrder(order, input.razorpayPayments) !== Number(order.amount)) {
    return { honoured: false, reason: "not_paid" }
  }
  return { honoured: true }
}
