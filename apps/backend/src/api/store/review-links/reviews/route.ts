import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { submitProductReviewsWorkflow } from "../../../../workflows/submit-product-reviews"
import type { LinkReviewsBody } from "../../../review-validation"

/**
 * POST /store/review-links/reviews  { token, reviews: [{ line_item_id, rating, title?, body, display_name?, photo_ids? }] }
 *
 * Sends reviews with a review link. The link works once: afterwards the
 * customer changes a review from their order page.
 */
export async function POST(req: MedusaRequest<LinkReviewsBody>, res: MedusaResponse) {
  const { result } = await submitProductReviewsWorkflow(req.scope).run({
    input: { reviewer: { source: "link", token: req.validatedBody.token }, reviews: req.validatedBody.reviews },
  })
  return res.status(201).json({ reviews: result.reviews, status: "pending" })
}
