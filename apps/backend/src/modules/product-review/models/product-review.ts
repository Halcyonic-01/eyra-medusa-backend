import { model } from "@medusajs/framework/utils"
import { REJECTION_REASONS, REVIEW_SOURCES, REVIEW_STATUSES } from "../constants"
import { ReviewPhoto } from "./review-photo"

/**
 * A customer's review of one product they bought and received. One per
 * customer per product: buying it again, or coming back later, edits the same
 * review, and an edit is checked again before it shows.
 */
export const ProductReview = model
  .define("product_review", {
    id: model.id({ prefix: "prev" }).primaryKey(),
    product_id: model.text(),
    variant_id: model.text().nullable(),
    /** The order and line the purchase is proven by. */
    order_id: model.text(),
    line_item_id: model.text(),
    customer_id: model.text().nullable(),
    customer_email: model.text().nullable(),
    /** customer_id, or the email when there is no customer: one review per key and product. */
    customer_key: model.text(),
    rating: model.number(),
    title: model.text().nullable(),
    body: model.text(),
    /** The name shown with the review, for example "Priya S.". */
    display_name: model.text(),
    /** What was bought, as it was named at the time. */
    product_title: model.text().nullable(),
    variant_title: model.text().nullable(),
    status: model.enum([...REVIEW_STATUSES]).default("pending"),
    /** Every review here is tied to a delivered order line. */
    verified_purchase: model.boolean().default(true),
    source: model.enum([...REVIEW_SOURCES]),
    /** Spam signals found when it was submitted, for the moderator. */
    flags: model.json().nullable(),
    rejection_reason: model.enum([...REJECTION_REASONS]).nullable(),
    moderation_note: model.text().nullable(),
    moderated_by: model.text().nullable(),
    moderated_at: model.dateTime().nullable(),
    submitted_at: model.dateTime(),
    edited_at: model.dateTime().nullable(),
    photos: model.hasMany(() => ReviewPhoto, { mappedBy: "review" }),
  })
  .indexes([
    { on: ["product_id", "customer_key"], unique: true, where: "deleted_at IS NULL" },
    { on: ["product_id", "status"] },
    { on: ["status"] },
    { on: ["order_id"] },
    { on: ["customer_id"] },
  ])
