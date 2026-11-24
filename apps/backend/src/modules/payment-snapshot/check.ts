import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { CART_RULE_FIELDS } from "../../utils/cart-summary"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { isPrepaidProvider, sessionAttempt } from "./gateways"
import {
  judgePaidSnapshot,
  snapshotMatchesCart,
  attemptRef,
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
  /** Every online (prepaid) session still on the cart, whichever provider. */
  prepaidSessions: SessionLike[]
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
    prepaidSessions: sessions.filter((s) => isPrepaidProvider(s.provider_id)),
  }
}

/** The current attempt recorded for a session (a superseded one never holds it). */
export async function snapshotFor(container: MedusaContainer, sessionId: string): Promise<PaymentSnapshotRecord | null> {
  const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
  const [snapshot] = await service.listPaymentPriceSnapshots({ payment_session_id: sessionId, superseded_at: null }, { take: 1 })
  return (snapshot as unknown as PaymentSnapshotRecord) ?? null
}

/**
 * Whether the cart's current online payment was opened at a snapshotted price
 * and its provider confirms it was paid in full. The provider is asked only
 * when the cart still matches its snapshot. Throws GatewayUnavailableError when
 * the provider cannot be asked, so callers can fail closed.
 */
export async function checkPaidSnapshot(container: MedusaContainer, cartId: string): Promise<SnapshotVerdict> {
  const state = await loadCartPaymentState(container, cartId)
  const { gateway, ref } = sessionAttempt(state?.session)
  if (!state?.session || !gateway) return { honoured: false, reason: "no_snapshot" }
  const snapshot = await snapshotFor(container, state.session.id)
  const local = snapshotMatchesCart(snapshot, state.cart, state.session, ref)
  if (!local.honoured) return local

  const attempt = await gateway.fetchAttempt(attemptRef(snapshot as PaymentSnapshotRecord))
  return judgePaidSnapshot({ snapshot, cart: state.cart, session: state.session, sessionRef: ref, attempt })
}
