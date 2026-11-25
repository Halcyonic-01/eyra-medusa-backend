import { model } from "@medusajs/framework/utils"

/**
 * What a cart cost when an online payment attempt was opened (a Razorpay
 * order; later other providers): every line at the price
 * charged, the amount the payment session asks for, and the Razorpay order made
 * for it. Written by the backend only, right after repricing the cart to today's
 * prices, so a customer who pays it gets the order at that price even if a sale
 * ends while they are paying.
 *
 * One row per attempt; a new attempt makes a new session and a new row. Rows
 * are kept after Medusa deletes the session they were opened with, so a late
 * payment on a replaced attempt can still be found. Amounts are whole paise.
 */
export const PaymentPriceSnapshot = model
  .define("payment_price_snapshot", {
    id: model.id({ prefix: "pps" }).primaryKey(),
    cart_id: model.text(),
    payment_collection_id: model.text(),
    payment_session_id: model.text(),
    provider_id: model.text(),
    /** The provider's attempt (a Razorpay order id). Null only on rows written before this column. */
    provider_ref: model.text().nullable(),
    /** What the provider's attempt asks for, in paise. Must equal amount_paise. */
    provider_amount_paise: model.number().nullable(),
    /** Same as provider_ref and provider_amount_paise, on Razorpay rows only. Kept for older rows and rollback. */
    razorpay_order_id: model.text().nullable(),
    razorpay_amount_paise: model.number().nullable(),
    currency_code: model.text(),
    /** The cart total and payment session amount, in paise. */
    amount_paise: model.number(),
    /** [{ id, variant_id, quantity, unit_price_paise }], sorted by id. */
    lines: model.json(),
    /** A newer attempt replaced this one; only the current attempt holds its session id. */
    superseded_at: model.dateTime().nullable(),
    /** When the late-payment sweep last asked Razorpay about this attempt. */
    late_checked_at: model.dateTime().nullable(),
    /** When the missed-confirmation sweep last asked the provider about this attempt while it was the cart's current one. */
    reconciled_at: model.dateTime().nullable(),
  })
  .indexes([
    { on: ["cart_id"] },
    { on: ["payment_session_id"], unique: true, where: "deleted_at IS NULL AND superseded_at IS NULL" },
    { on: ["razorpay_order_id"], unique: true, where: "deleted_at IS NULL" },
    { on: ["provider_id", "provider_ref"], unique: true, where: "deleted_at IS NULL AND provider_ref IS NOT NULL" },
  ])
