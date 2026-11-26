import type { MedusaContainer } from "@medusajs/framework/types"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { loadCartPaymentState, snapshotFor } from "./check"
import { GatewayUnavailableError, RAZORPAY_PROVIDER_ID, getGateway, ownPayments, paidTowardsAttempt, sessionAttempt } from "./gateways"
import { snapshotMatchesCart } from "./rules"
import { loadCartOrder, paidAttempts, type PaidAttempts, type PendingPayment } from "./late-payments"
import type PaymentSnapshotModuleService from "./service"

/**
 * Where a cart's online payment stands, for the customer: what the storefront
 * shows before and after paying, and whether paying (again) is allowed. Every
 * answer comes from the providers' own records and the backend's ledger, and
 * an uncertain one never allows a payment.
 */

/**
 * How long a payment still in progress at a provider blocks every new payment,
 * the same provider included. UPI and netbanking approvals usually settle well
 * within this; after it a retry is allowed, and should the old payment still go
 * through it is refunded automatically (late-payment settle), never kept twice.
 */
export const PENDING_HOLD_MINUTES = 30

export type StandingState =
  /** The cart is an order. */
  | "ordered"
  /** Money was taken and the order is being placed. */
  | "paid"
  /** A payment is still in progress at a provider. */
  | "pending"
  /** A provider could not be asked just now. */
  | "unknown"
  /** Nothing paid or in progress (a payment may be opened). */
  | "none"

export type StandingRefund = {
  provider_id: string
  provider_name: string
  amount: number
  /** refunding: owed, being sent. refunded: accepted by the provider. paid_out: the provider paid it. review: a person is looking at it. */
  status: "refunding" | "refunded" | "paid_out" | "review"
}

export type PaymentStanding = {
  cart_id: string
  state: StandingState
  order_id: string | null
  provider_id: string | null
  provider_name: string | null
  /** For "pending": when the payment started, and when another payment may be tried. */
  pending_since: string | null
  retry_after: string | null
  /** Whether a new online payment may be opened now, and with which providers ("pending" past the hold: same provider only). */
  can_pay: boolean
  allowed_providers: string[] | "any"
  /**
   * The pending payment is on the cart's current Razorpay order and the cart is
   * unchanged: paying again continues that same order, which Razorpay lets be
   * paid only once, so it cannot charge twice.
   */
  resume: boolean
  refunds: StandingRefund[]
}

const name = (providerId: string | null) => (providerId ? getGateway(providerId)?.name ?? "your payment provider" : null)

/** Pure: what a pending payment permits. Within the hold nothing; after it, the same provider only (switching waits until it settles). */
export function pendingRule(pending: PendingPayment[], now: Date): { can_pay: boolean; allowed: string[]; retry_after: Date } {
  const latest = pending.reduce((a, b) => (a.since > b.since ? a : b))
  const retryAfter = new Date(latest.since.getTime() + PENDING_HOLD_MINUTES * 60 * 1000)
  const providers = [...new Set(pending.map((p) => p.provider_id))]
  if (now < retryAfter || providers.length > 1) return { can_pay: false, allowed: [], retry_after: retryAfter }
  return { can_pay: true, allowed: providers, retry_after: retryAfter }
}

/** Pure: the standing from what the providers and the ledger said. */
export function judgeStanding(
  input: { cart_id: string; order_id: string | null; paid: PaidAttempts | null; refunds: StandingRefund[] },
  now: Date = new Date()
): PaymentStanding {
  const base = { cart_id: input.cart_id, order_id: input.order_id, refunds: input.refunds, pending_since: null, retry_after: null, resume: false }
  if (input.order_id) {
    return { ...base, state: "ordered", provider_id: null, provider_name: null, can_pay: false, allowed_providers: [] }
  }
  if (!input.paid) {
    return { ...base, state: "unknown", provider_id: null, provider_name: null, can_pay: false, allowed_providers: [] }
  }
  if (input.paid.current || input.paid.replaced) {
    const provider = input.paid.paid_provider
    return { ...base, state: "paid", provider_id: provider, provider_name: name(provider), can_pay: false, allowed_providers: [] }
  }
  if (input.paid.pending.length) {
    const rule = pendingRule(input.paid.pending, now)
    const latest = input.paid.pending.reduce((a, b) => (a.since > b.since ? a : b))
    return {
      ...base,
      state: "pending",
      provider_id: latest.provider_id,
      provider_name: name(latest.provider_id),
      pending_since: latest.since.toISOString(),
      retry_after: rule.retry_after.toISOString(),
      can_pay: rule.can_pay,
      allowed_providers: rule.allowed,
    }
  }
  return { ...base, state: "none", provider_id: null, provider_name: null, can_pay: true, allowed_providers: "any" }
}

type LedgerRow = { provider_id: string; amount_paise: number; status: string; refund_verified_at: Date | null }

/** Refunds owed or made on the cart's payments, newest first. */
async function cartRefunds(container: MedusaContainer, cartId: string): Promise<StandingRefund[]> {
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const rows = (await service.listLateRazorpayPayments({ cart_id: cartId }, { order: { created_at: "DESC" } })) as unknown as LedgerRow[]
  return rows
    .filter((row) => row.status !== "recovered")
    .map((row) => ({
      provider_id: row.provider_id,
      provider_name: name(row.provider_id) ?? "your payment provider",
      amount: row.amount_paise / 100,
      status: row.status === "refunded" ? (row.refund_verified_at ? "paid_out" : "refunded") : row.status === "refunding" ? "refunding" : "review",
    }))
}

export type ResumableAttempt = { payment_collection_id: string; payment_session_id: string; razorpay_order_id: string; amount: number }

/**
 * The cart's current Razorpay order, when it may be paid again as it is: the
 * cart and its session still match what the order was opened for, nothing has
 * been taken on it, and a payment on it is still in limbo at Razorpay
 * ("created": a failed or abandoned netbanking or UPI try that Razorpay keeps
 * open). Razorpay accepts one successful payment per order, so the customer
 * continues the same order instead of opening a second one. Null otherwise,
 * also when Razorpay cannot be asked.
 */
export async function resumableRazorpayAttempt(container: MedusaContainer, cartId: string): Promise<ResumableAttempt | null> {
  const state = await loadCartPaymentState(container, cartId)
  const session = state?.session
  if (!state || state.cart.completed_at || !session || session.provider_id !== RAZORPAY_PROVIDER_ID) return null
  const ref = sessionAttempt(session).ref
  const snapshot = await snapshotFor(container, session.id)
  if (!ref || !snapshot || !snapshotMatchesCart(snapshot, state.cart, session, ref).honoured) return null
  let attempt
  try {
    attempt = await getGateway(RAZORPAY_PROVIDER_ID)?.fetchAttempt(ref)
  } catch (error) {
    if (error instanceof GatewayUnavailableError) return null
    throw error
  }
  if (!attempt || paidTowardsAttempt(attempt) > 0) return null
  if ((attempt.raw as { status?: string } | null)?.status === "paid") return null
  if (!ownPayments(attempt).some((p) => p.status === "pending")) return null
  return {
    payment_collection_id: state.cart.payment_collection?.id ?? "",
    payment_session_id: session.id,
    razorpay_order_id: ref,
    amount: snapshot.amount_paise / 100,
  }
}

/** Null when the cart does not exist. */
export async function cartPaymentStanding(container: MedusaContainer, cartId: string, now: Date = new Date()): Promise<PaymentStanding | null> {
  const state = await loadCartPaymentState(container, cartId)
  if (!state) return null
  const refunds = await cartRefunds(container, cartId)
  const order = await loadCartOrder(container, cartId)
  if (order) return judgeStanding({ cart_id: cartId, order_id: order.id, paid: null, refunds }, now)
  let paid: PaidAttempts | null = null
  try {
    paid = await paidAttempts(container, cartId, state.prepaidSessions)
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error
  }
  const standing = judgeStanding({ cart_id: cartId, order_id: null, paid, refunds }, now)
  if (standing.state === "pending" && standing.provider_id === RAZORPAY_PROVIDER_ID && paid?.pending.every((p) => p.provider_id === RAZORPAY_PROVIDER_ID)) {
    if (await resumableRazorpayAttempt(container, cartId)) {
      return { ...standing, can_pay: true, allowed_providers: [RAZORPAY_PROVIDER_ID], resume: true }
    }
  }
  return standing
}
