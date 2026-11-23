import { model } from "@medusajs/framework/utils"

/**
 * A Razorpay payment taken on an attempt that is no longer the cart's current
 * one, and what was done about it. One row per Razorpay payment, so the same
 * payment is never acted on twice.
 *
 * `status`:
 * - recovered:    the attempt became the cart's order
 * - refunding:    a refund is owed; tried until Razorpay confirms it
 * - refunded:     Razorpay confirmed the refund
 * - needs_review: could not be refunded automatically, a person must look
 */
export const LateRazorpayPayment = model
  .define("late_razorpay_payment", {
    id: model.id({ prefix: "lrp" }).primaryKey(),
    cart_id: model.text(),
    snapshot_id: model.text(),
    razorpay_order_id: model.text(),
    razorpay_payment_id: model.text(),
    amount_paise: model.number(),
    currency_code: model.text(),
    status: model.enum(["recovered", "refunding", "refunded", "needs_review"]),
    /** Why it was refunded (or the order it became, see order_id). */
    reason: model.text().nullable(),
    order_id: model.text().nullable(),
    refund_id: model.text().nullable(),
    refund_attempts: model.number().default(0),
    last_error: model.text().nullable(),
    alerted_at: model.dateTime().nullable(),
    resolved_at: model.dateTime().nullable(),
  })
  .indexes([
    { on: ["cart_id"] },
    { on: ["razorpay_payment_id"], unique: true, where: "deleted_at IS NULL" },
    { on: ["status"] },
  ])
