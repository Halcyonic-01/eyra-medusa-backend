import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { CART_RULE_FIELDS } from "../../utils/cart-summary"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { fetchRazorpayOrderPayments } from "./razorpay-api"
import {
  RAZORPAY_PROVIDER_ID,
  judgePaidSnapshot,
  paidTowardsOrder,
  sessionRazorpayOrderId,
  snapshotMatchesCart,
  type CartLike,
  type PaymentSnapshotRecord,
  type SessionLike,
  type SnapshotVerdict,
} from "./rules"
import type PaymentSnapshotModuleService from "./service"

// The statuses Medusa will go on to process when completing a cart.
const PROCESSABLE = ["pending", "requires_more", "authorized"]

const PAYMENT_FIELDS = [
  ...CART_RULE_FIELDS,
  "payment_collection.id",
  "payment_collection.payment_sessions.id",
  "payment_collection.payment_sessions.provider_id",
  "payment_collection.payment_sessions.status",
  "payment_collection.payment_sessions.amount",
  "payment_collection.payment_sessions.currency_code",
  "payment_collection.payment_sessions.data",
]

export type CartPaymentState = {
  cart: CartLike & { completed_at?: unknown; payment_collection?: { id?: string } | null }
  /** The session Medusa would use to complete the cart, if any. */
  session: SessionLike | null
  /** Every Razorpay session still on the cart. */
  razorpaySessions: SessionLike[]
}

export async function loadCartPaymentState(container: MedusaContainer, cartId: string): Promise<CartPaymentState | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "cart", fields: PAYMENT_FIELDS, filters: { id: cartId } })
  const cart = data[0] as unknown as CartPaymentState["cart"] & {
    payment_collection?: { id?: string; payment_sessions?: (SessionLike | null)[] } | null
  }
  if (!cart) return null
  const sessions = (cart.payment_collection?.payment_sessions ?? []).filter((s): s is SessionLike => Boolean(s))
  const processable = sessions.filter((s) => s.status && PROCESSABLE.includes(s.status))
  return {
    cart,
    session: processable[0] ?? null,
    razorpaySessions: sessions.filter((s) => s.provider_id === RAZORPAY_PROVIDER_ID),
  }
}

async function snapshotFor(container: MedusaContainer, sessionId: string): Promise<PaymentSnapshotRecord | null> {
  const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
  const [snapshot] = await service.listPaymentPriceSnapshots({ payment_session_id: sessionId }, { take: 1 })
  return (snapshot as unknown as PaymentSnapshotRecord) ?? null
}

/**
 * Whether the cart's current Razorpay payment was opened at a snapshotted price
 * and Razorpay confirms it was paid in full. Razorpay is asked only when the
 * cart still matches its snapshot. Throws RazorpayUnavailableError when
 * Razorpay cannot be asked, so callers can fail closed.
 */
export async function checkPaidSnapshot(container: MedusaContainer, cartId: string): Promise<SnapshotVerdict> {
  const state = await loadCartPaymentState(container, cartId)
  if (!state?.session || state.session.provider_id !== RAZORPAY_PROVIDER_ID) {
    return { honoured: false, reason: "no_snapshot" }
  }
  const snapshot = await snapshotFor(container, state.session.id)
  const local = snapshotMatchesCart(snapshot, state.cart, state.session)
  if (!local.honoured) return local

  const { order, payments } = await fetchRazorpayOrderPayments((snapshot as PaymentSnapshotRecord).razorpay_order_id)
  return judgePaidSnapshot({
    snapshot,
    cart: state.cart,
    session: state.session,
    razorpayOrder: order,
    razorpayPayments: payments,
  })
}

/**
 * Whether money has already been taken for any Razorpay session on the cart.
 * Opening a new payment would drop that session, so the paid one could never
 * become an order. Throws RazorpayUnavailableError when Razorpay cannot be asked.
 */
export async function hasPaidRazorpaySession(container: MedusaContainer, state: CartPaymentState): Promise<boolean> {
  for (const session of state.razorpaySessions) {
    const razorpayOrderId = sessionRazorpayOrderId(session)
    if (!razorpayOrderId) continue
    const { order, payments } = await fetchRazorpayOrderPayments(razorpayOrderId)
    if (order && paidTowardsOrder(order, payments) > 0) return true
  }
  return false
}
