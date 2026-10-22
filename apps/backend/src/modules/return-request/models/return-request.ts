import { model } from "@medusajs/framework/utils"
import { ALL_REASONS, RETURN_STATUSES } from "../constants"

/**
 * A customer's request to return, or exchange, items from a delivered order.
 *
 * A return books a reverse pickup at once, and when the item passes the quality
 * check our team marks it received: that issues store credit (the item's paid
 * value less the ₹99 reverse fee) and a GST credit note. An exchange first
 * collects a ₹99 handling fee (plus any price difference) through a Razorpay
 * payment link, then books the pickup, and sends the replacement once the old
 * item passes the check. Older requests are decided by hand and issue credit
 * for an amount staff choose.
 */
export const ReturnRequest = model
  .define("return_request", {
    id: model.id({ prefix: "retreq" }).primaryKey(),
    order_id: model.text(),
    customer_id: model.text(),
    type: model.enum(["return", "exchange"]),
    reason: model.enum([...ALL_REASONS]),
    note: model.text().nullable(),
    /** Snapshot of what was requested: item_id, title, quantity, unit_price, total. */
    items: model.json(),
    status: model.enum([...RETURN_STATUSES]).default("pending"),
    /** Store credit issued when approved. */
    credit_amount: model.bigNumber().nullable(),
    /** Staff's message back to the customer. */
    resolution_note: model.text().nullable(),
    resolved_by: model.text().nullable(),
    resolved_at: model.dateTime().nullable(),

    /** When the order was delivered, as known when the request was made. */
    delivered_at: model.dateTime().nullable(),
    /** What the customer paid for the requested items, GST included, after any discount. */
    paid_value: model.bigNumber().nullable(),
    /** The reverse logistics fee kept from a return's credit. */
    fee_amount: model.bigNumber().nullable(),

    /** The reverse pickup at the courier. */
    reverse_order_ref: model.text().nullable(),
    reverse_shipment_id: model.text().nullable(),
    reverse_awb: model.text().nullable(),
    reverse_requested_at: model.dateTime().nullable(),
    reverse_error: model.text().nullable(),

    /** Exchange: what is wanted instead, and what the customer owes to get it. */
    replacement_variant_id: model.text().nullable(),
    replacement_title: model.text().nullable(),
    replacement_price: model.bigNumber().nullable(),
    /** Replacement price less what was paid; positive when the customer pays more. */
    price_difference: model.bigNumber().nullable(),
    /** The Razorpay payment link amount: the handling fee plus any extra price. */
    amount_due: model.bigNumber().nullable(),
    fee_link_id: model.text().nullable(),
    fee_link_url: model.text().nullable(),
    fee_paid_at: model.dateTime().nullable(),
    /** The Razorpay payment that paid the link. */
    fee_payment_id: model.text().nullable(),
    replacement_order_id: model.text().nullable(),

    credit_note_id: model.text().nullable(),
    received_at: model.dateTime().nullable(),
    received_by: model.text().nullable(),
  })
  .indexes([
    { on: ["order_id"] },
    { on: ["customer_id"] },
    { on: ["status"] },
    { on: ["fee_link_id"], unique: true, where: "fee_link_id IS NOT NULL AND deleted_at IS NULL" },
    { on: ["reverse_order_ref"], unique: true, where: "reverse_order_ref IS NOT NULL AND deleted_at IS NULL" },
    { on: ["reverse_awb"], where: "reverse_awb IS NOT NULL AND deleted_at IS NULL" },
  ])
