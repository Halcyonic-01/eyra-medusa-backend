import { model } from "@medusajs/framework/utils"
import { ReviewNotification } from "./review-notification"

/**
 * The invitation to review a delivered order: one per order. It holds the
 * review link (never the link itself, only what it can be recognised by) and
 * the messages sent about it.
 *
 * The link is rebuilt from token_nonce and a server secret when a message needs
 * it, so the reminder can carry the same link without the link being stored.
 */
export const ReviewRequest = model
  .define("review_request", {
    id: model.id({ prefix: "revreq" }).primaryKey(),
    order_id: model.text(),
    customer_id: model.text().nullable(),
    email: model.text().nullable(),
    phone: model.text().nullable(),
    first_name: model.text().nullable(),
    whatsapp_opt_in: model.boolean().default(false),
    delivered_at: model.dateTime().nullable(),
    token_nonce: model.text(),
    /** sha256 of the link token. */
    token_hash: model.text(),
    token_expires_at: model.dateTime(),
    /** The link is single use: set when reviews are sent with it. */
    token_used_at: model.dateTime().nullable(),
    opened_at: model.dateTime().nullable(),
    /** The customer reviewed, by the link or from their order page. */
    completed_at: model.dateTime().nullable(),
    notifications: model.hasMany(() => ReviewNotification, { mappedBy: "request" }),
  })
  .indexes([
    { on: ["order_id"], unique: true, where: "deleted_at IS NULL" },
    { on: ["token_hash"], unique: true, where: "deleted_at IS NULL" },
  ])
