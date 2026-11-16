import { model } from "@medusajs/framework/utils"
import { PHOTO_STATUSES } from "../constants"
import { ProductReview } from "./product-review"

/**
 * A photo a customer uploaded for a review, kept in Medusa's file storage. It is
 * uploaded before the review is sent, so it belongs to the order first and to
 * a review once the review is saved.
 */
export const ReviewPhoto = model
  .define("review_photo", {
    id: model.id({ prefix: "revph" }).primaryKey(),
    order_id: model.text(),
    /** The file in Medusa's file storage, and its public address. */
    file_id: model.text(),
    url: model.text(),
    mime_type: model.text(),
    size: model.number(),
    status: model.enum([...PHOTO_STATUSES]).default("uploaded"),
    review: model.belongsTo(() => ProductReview, { mappedBy: "photos" }).nullable(),
  })
  .indexes([{ on: ["order_id"] }, { on: ["status"] }])
