import { roundMoney } from "../wallet/utils"

/**
 * The rules of customer cancellation, kept free of any database or Medusa call
 * so they can be checked on their own. The workflow and the preview both use
 * them, so what the customer is shown is exactly what happens.
 */

export const CANCEL_REASONS = [
  "changed_mind",
  "ordered_by_mistake",
  "found_better_price",
  "delivery_time",
  "address_or_details",
  "other",
] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

export type RefundMethod = "wallet" | "original"

/** How the order was paid, which decides what a cancellation can refund. */
export type PaymentKind = "online" | "online_and_wallet" | "wallet_only" | "cod" | "cod_and_wallet"

export type CancellationContext = {
  order_id: string
  display_id: number
  customer_id: string | null
  email: string | null
  order_status: string
  placed_at: string
  /** What the customer had to pay, after wallet credit. */
  total: number
  /** Wallet credit the order used. */
  wallet_used: number
  /** Online payments with something captured and not yet refunded. */
  online_payments: { payment_id: string; refundable: number }[]
  /** Total refundable across online payments. */
  paid_online: number
  /** An online payment exists that has not been captured. */
  has_unsettled_online: boolean
  razorpay_payment_id: string | null
  /** Razorpay's order id, to find the payment when its id was not recorded. */
  razorpay_order_id: string | null
  /** The order has a Razorpay payment of any kind. */
  has_razorpay_payment?: boolean
  /** A Medusa fulfillment exists that was not cancelled, so staff have started shipping by hand. */
  has_active_fulfillment?: boolean
}

export type RefundOption = {
  method: RefundMethod
  /** What the customer receives. */
  amount: number
  /** What is kept (only for the original payment method). */
  fee: number
  available: boolean
  unavailable_reason?: string
}

export type CancellationPlan = {
  kind: PaymentKind
  paid_online: number
  wallet_used: number
  /** True when the customer must choose where the online payment goes. */
  requires_choice: boolean
  wallet: RefundOption | null
  original: RefundOption | null
}

export function paymentKind(ctx: Pick<CancellationContext, "paid_online" | "wallet_used" | "total">): PaymentKind {
  if (ctx.paid_online > 0) {
    return ctx.wallet_used > 0 ? "online_and_wallet" : "online"
  }
  if (ctx.total > 0) {
    return ctx.wallet_used > 0 ? "cod_and_wallet" : "cod"
  }
  return "wallet_only"
}

/**
 * What a cancellation can refund, and to where. The wallet always gets the full
 * amount paid online. The original payment method gets that amount less the fee
 * (never more than the amount itself), and is only offered if something is left.
 * Wallet credit the order used is not part of this: it always returns in full.
 */
export function planCancellation(ctx: CancellationContext, fee: number): CancellationPlan {
  const kind = paymentKind(ctx)
  const paid = roundMoney(ctx.paid_online)

  if (paid <= 0) {
    return {
      kind,
      paid_online: 0,
      wallet_used: roundMoney(ctx.wallet_used),
      requires_choice: false,
      wallet: null,
      original: null,
    }
  }

  const kept = Math.min(roundMoney(fee), paid)
  const toOriginal = roundMoney(paid - kept)

  return {
    kind,
    paid_online: paid,
    wallet_used: roundMoney(ctx.wallet_used),
    requires_choice: true,
    wallet: { method: "wallet", amount: paid, fee: 0, available: true },
    original: {
      method: "original",
      amount: toOriginal,
      fee: kept,
      available: toOriginal >= 1,
      ...(toOriginal >= 1 ? {} : { unavailable_reason: "The amount paid is too small to refund after the cancellation fee" }),
    },
  }
}

/** Why an order cannot be cancelled by the customer right now. */
export type BlockCode =
  | "not_your_order"
  | "already_cancelled"
  | "shipment_created"
  | "preparing"
  | "not_trackable"
  | "payment_not_settled"

export type Eligibility = { can_cancel: true } | { can_cancel: false; code: BlockCode }

type DispatchView = { state: string; window_ends_at: Date | string } | null

/**
 * Whether the customer can cancel now. "preparing" means the cancel window has
 * closed (or closes right now) and the shipment is about to be, or is being,
 * created. A shipment that exists always blocks.
 */
export function evaluateEligibility(
  ctx: CancellationContext,
  customerId: string | null,
  dispatch: DispatchView,
  now: Date = new Date()
): Eligibility {
  if (!customerId || ctx.customer_id !== customerId) {
    return { can_cancel: false, code: "not_your_order" }
  }
  if (ctx.order_status === "canceled") {
    return { can_cancel: false, code: "already_cancelled" }
  }
  if (!dispatch) {
    return { can_cancel: false, code: "not_trackable" }
  }
  if (dispatch.state === "shipped") {
    return { can_cancel: false, code: "shipment_created" }
  }
  if (dispatch.state === "cancelled" || dispatch.state === "cancelling") {
    return { can_cancel: false, code: "already_cancelled" }
  }
  if (dispatch.state !== "placed" || new Date(dispatch.window_ends_at).getTime() <= now.getTime()) {
    return { can_cancel: false, code: "preparing" }
  }
  if (ctx.has_active_fulfillment) {
    return { can_cancel: false, code: "preparing" }
  }
  if (ctx.has_unsettled_online) {
    return { can_cancel: false, code: "payment_not_settled" }
  }
  return { can_cancel: true }
}

export const BLOCK_MESSAGES: Record<BlockCode, string> = {
  not_your_order: "This order could not be found.",
  already_cancelled: "This order has already been cancelled.",
  shipment_created: "The shipment has been created, so this order can't be cancelled now.",
  preparing: "Your order is being prepared for shipping, so it can't be cancelled now.",
  not_trackable: "This order can't be cancelled online. Please contact support.",
  payment_not_settled: "Your payment is still being confirmed. Please try again in a few minutes.",
}

export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "string" && (CANCEL_REASONS as readonly string[]).includes(value)
}
