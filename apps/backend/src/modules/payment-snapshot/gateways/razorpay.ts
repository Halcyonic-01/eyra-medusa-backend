import { Modules } from "@medusajs/framework/utils"
import { getRefundGateway } from "../../order-dispatch/refund-gateway"
import { fetchRazorpayOrderPayments } from "../razorpay-api"
import { RAZORPAY_PROVIDER_ID } from "./ids"
import { razorpayAttempt, sessionRazorpayAmount, sessionRazorpayOrderId, type RazorpayOrder } from "./razorpay-shape"
import type { PrepaidGateway } from "./types"

/** Razorpay through medusa-plugin-razorpay-v2: an attempt is a Razorpay order. */
export const razorpayGateway: PrepaidGateway = {
  provider_id: RAZORPAY_PROVIDER_ID,
  name: "Razorpay",
  sessionRef: sessionRazorpayOrderId,
  sessionAttemptAmount: sessionRazorpayAmount,

  async fetchAttempt(ref) {
    const { order, payments } = await fetchRazorpayOrderPayments(ref)
    return order ? razorpayAttempt(order, payments) : null
  },

  /**
   * The plugin's update keeps the Razorpay order it is given instead of opening
   * a new one, and finds the session through the order's notes, so those are
   * pointed at this session first.
   */
  async rebindSession(container, session, attempt, amount, currencyCode) {
    const order = attempt.raw as RazorpayOrder
    const notes = { ...(order.notes ?? {}), medusa_payment_session_id: session.id }
    await container.resolve(Modules.PAYMENT).updatePaymentSession({
      id: session.id,
      amount,
      currency_code: currencyCode,
      data: { razorpayOrder: { ...order, notes } },
      context: { idempotency_key: session.id },
    } as never)
  },

  refunds: () => getRefundGateway(RAZORPAY_PROVIDER_ID),
}
