import { model } from "@medusajs/framework/utils"

/**
 * What a cart cost when its Razorpay payment was opened: every line at the price
 * charged, the amount the payment session asks for, and the Razorpay order made
 * for it. Written by the backend only, right after repricing the cart to today's
 * prices, so a customer who pays it gets the order at that price even if a sale
 * ends while they are paying.
 *
 * One row per payment session; a new attempt makes a new session and a new row.
 * Amounts are whole paise.
 */
export const PaymentPriceSnapshot = model
  .define("payment_price_snapshot", {
    id: model.id({ prefix: "pps" }).primaryKey(),
    cart_id: model.text(),
    payment_collection_id: model.text(),
    payment_session_id: model.text(),
    provider_id: model.text(),
    razorpay_order_id: model.text(),
    currency_code: model.text(),
    /** The cart total and payment session amount, in paise. */
    amount_paise: model.number(),
    /** The Razorpay order amount, in paise. Must equal amount_paise. */
    razorpay_amount_paise: model.number(),
    /** [{ id, variant_id, quantity, unit_price_paise }], sorted by id. */
    lines: model.json(),
  })
  .indexes([
    { on: ["cart_id"] },
    { on: ["payment_session_id"], unique: true, where: "deleted_at IS NULL" },
    { on: ["razorpay_order_id"], unique: true, where: "deleted_at IS NULL" },
  ])
