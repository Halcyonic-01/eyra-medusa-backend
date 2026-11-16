import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import type { ReviewInput } from "../modules/product-review/content"
import {
  completeReviewRequestStep,
  planReviewSubmissionStep,
  recomputeProductRatingsStep,
  saveProductReviewsStep,
  type Reviewer,
} from "./steps/review-submissions"

export type SubmitProductReviewsInput = { reviewer: Reviewer; reviews: ReviewInput[] }

/**
 * Saves a customer's reviews of the products on one delivered order, by the
 * review link (single use) or from their order page. Every review is checked
 * by our team before it shows; an edit goes back to be checked. Sending a
 * review calls off the reminder.
 */
export const submitProductReviewsWorkflow = createWorkflow("submit-product-reviews", function (input: SubmitProductReviewsInput) {
  // One submission per link or order at a time, so a double tap cannot spend a link twice.
  const lockKey = transform({ input }, (data) =>
    data.input.reviewer.source === "link" ? `review-link:${data.input.reviewer.token}` : `review-order:${data.input.reviewer.order_id}`
  )
  acquireLockStep({ key: lockKey, timeout: 10, ttl: 60 })

  const plan = planReviewSubmissionStep({ reviewer: input.reviewer, reviews: input.reviews })
  const saved = saveProductReviewsStep({ plan })
  const completion = transform({ plan }, (data) => ({
    request_id: data.plan.access.request?.id ?? null,
    source: data.plan.access.source,
  }))
  completeReviewRequestStep(completion)
  const productIds = transform({ plan }, (data) => data.plan.reviews.map((review) => review.product_id))
  recomputeProductRatingsStep({ product_ids: productIds })

  releaseLockStep({ key: lockKey })
  return new WorkflowResponse(saved)
})
