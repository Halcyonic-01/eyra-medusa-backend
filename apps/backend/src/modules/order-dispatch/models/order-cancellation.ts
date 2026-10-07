import { model } from "@medusajs/framework/utils"

/**
 * What happened when an order was cancelled by the customer: who asked, why,
 * where the refund went and how much. One row per order. It is also what the
 * storefront shows afterwards ("Refunded to your wallet", "Refund started").
 *
 * `status`:
 * - processing:      the cancellation is under way
 * - completed:       the order is cancelled and the refund has been dealt with
 * - needs_attention: money moved but something else did not, so a person must look
 *
 * `refund_status`:
 * - not_needed: nothing was paid online, so there is nothing to refund
 * - pending:    the refund has not been made yet
 * - initiated:  the refund was started with the payment provider and is on its way
 * - credited:   the refund was added to the customer's wallet
 * - failed:     the refund could not be made; staff can retry it
 * - unverified: it was sent, but the provider could not confirm it; staff must check
 */
export const OrderCancellation = model
  .define("order_cancellation", {
    id: model.id({ prefix: "ocnl" }).primaryKey(),
    order_id: model.text(),
    requested_by: model.enum(["customer", "staff"]).default("customer"),
    customer_id: model.text().nullable(),
    reason: model.text().nullable(),
    note: model.text().nullable(),
    refund_method: model.enum(["wallet", "original", "none"]).default("none"),
    /** What the customer paid online and had not been refunded yet. */
    paid_online: model.bigNumber().default(0),
    /** Wallet credit the order used, which always goes back to the wallet in full. */
    wallet_used: model.bigNumber().default(0),
    fee: model.bigNumber().default(0),
    /** What goes to the chosen destination out of `paid_online`. */
    refund_amount: model.bigNumber().default(0),
    status: model.enum(["processing", "completed", "needs_attention"]).default("processing"),
    refund_status: model
      .enum(["not_needed", "pending", "initiated", "credited", "failed", "unverified"])
      .default("pending"),
    razorpay_refund_id: model.text().nullable(),
    wallet_transaction_id: model.text().nullable(),
    refund_error: model.text().nullable(),
    /** Minutes between the order being placed and cancelled, to tune the window. */
    cancelled_after_minutes: model.number().nullable(),
    completed_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      on: ["order_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
  ])
