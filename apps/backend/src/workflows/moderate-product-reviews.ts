import { MedusaError } from "@medusajs/framework/utils"
import { createStep, createWorkflow, StepResponse, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_REVIEW_MODULE } from "../modules/product-review"
import { checkModeration } from "../modules/product-review/moderation"
import type ProductReviewModuleService from "../modules/product-review/service"
import { recomputeProductRatingsStep } from "./steps/review-submissions"

export type ModerateProductReviewsInput = {
  ids: string[]
  action: "approve" | "reject"
  reason?: string | null
  note?: string | null
  actor_id?: string | null
}

const moderateReviewsStep = createStep(
  "moderate-reviews",
  async (input: ModerateProductReviewsInput, { container }) => {
    const check = checkModeration(input)
    if (!check.ok) throw new MedusaError(MedusaError.Types.INVALID_DATA, check.error)
    const ids = [...new Set(input.ids)]
    if (!ids.length) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose at least one review.")
    if (ids.length > 100) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Moderate at most 100 reviews at a time.")
    const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
    const before = await service.listProductReviews({ id: ids }, { take: ids.length })
    if (before.length !== ids.length) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Some of those reviews were not found.")

    const now = new Date()
    const fields =
      check.action === "approve"
        ? { status: "approved" as const, rejection_reason: null, moderation_note: input.note?.trim() || null }
        : { status: "rejected" as const, rejection_reason: check.reason, moderation_note: check.note }
    await service.updateProductReviews(ids.map((id) => ({ id, ...fields, moderated_by: input.actor_id ?? null, moderated_at: now })))
    return new StepResponse(
      { ids, product_ids: [...new Set(before.map((review: any) => review.product_id as string))] },
      before.map((review: any) => ({
        id: review.id,
        status: review.status,
        rejection_reason: review.rejection_reason,
        moderation_note: review.moderation_note,
        moderated_by: review.moderated_by,
        moderated_at: review.moderated_at,
      }))
    )
  },
  async (before, { container }) => {
    if (!before?.length) return
    const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
    await service.updateProductReviews(before)
  }
)

/**
 * Approves or rejects reviews, one or many. A rejection must give one of the
 * published grounds and a note, and is recorded with who made it. The product's
 * rating is then worked out again from its approved reviews.
 */
export const moderateProductReviewsWorkflow = createWorkflow("moderate-product-reviews", function (input: ModerateProductReviewsInput) {
  const result = moderateReviewsStep(input)
  recomputeProductRatingsStep({ product_ids: transform({ result }, (data) => data.result.product_ids) })
  return new WorkflowResponse(result)
})
