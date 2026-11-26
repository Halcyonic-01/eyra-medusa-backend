import { model } from "@medusajs/framework/utils"

/**
 * Every payment webhook the guard let through, keyed by what it is about (the
 * provider's event and payment), so a redelivered or duplicated notice is not
 * handed to Medusa again while the first one is being processed or once its
 * cart is an order. One row per provider and key.
 *
 * `outcome`:
 * - forwarded: handed to Medusa's payment workflow
 * - settling:  a replaced attempt; handed to the late-payment settle
 */
export const PaymentWebhookEvent = model
  .define("payment_webhook_event", {
    id: model.id({ prefix: "pwe" }).primaryKey(),
    provider_id: model.text(),
    /** e.g. "payment.captured:pay_123" or "success:eyra1a2b3c" (PayU: status and txnid). */
    event_key: model.text(),
    event_type: model.text(),
    /** The provider's own event id, when it sends one. */
    provider_event_id: model.text().nullable(),
    attempt_ref: model.text().nullable(),
    cart_id: model.text().nullable(),
    outcome: model.enum(["forwarded", "settling"]),
    deliveries: model.number().default(1),
    /** Duplicates answered without acting. */
    duplicates: model.number().default(0),
    /** When it was last handed on; a redelivery after the replay window is handed on again if the cart is still not an order. */
    forwarded_at: model.dateTime(),
    last_seen_at: model.dateTime(),
  })
  .indexes([
    { on: ["provider_id", "event_key"], unique: true, where: "deleted_at IS NULL" },
    { on: ["cart_id"] },
  ])
