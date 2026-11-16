import { MedusaError } from "@medusajs/framework/utils"
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_REVIEW_MODULE } from "../modules/product-review"
import type ProductReviewModuleService from "../modules/product-review/service"
import { hashToken, linkExpiry, linkSecret, linkToken, newNonce, reviewLinkBase, reviewLinkUrl } from "../modules/product-review/tokens"
import { openReviewRequest } from "./steps/review-notifications"

const issueReviewLinkStep = createStep("issue-review-link", async (input: { order_id: string }, { container }) => {
  const opened = await openReviewRequest(container, input.order_id)
  if (!opened.request_id) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `This order cannot be reviewed yet (${opened.reason ?? "unknown"}).`)
  }
  const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
  const before = await service.retrieveReviewRequest(opened.request_id)
  const nonce = newNonce()
  const token = linkToken(linkSecret(), opened.request_id, nonce)
  const now = new Date()
  await service.updateReviewRequests({
    id: opened.request_id,
    token_nonce: nonce,
    token_hash: hashToken(token),
    token_expires_at: linkExpiry(now),
    token_used_at: null,
  })
  const base = reviewLinkBase()
  return new StepResponse(
    { request_id: opened.request_id, url: base ? reviewLinkUrl(base, token) : null, token, expires_at: linkExpiry(now) },
    { id: before.id, token_nonce: before.token_nonce, token_hash: before.token_hash, token_expires_at: before.token_expires_at, token_used_at: before.token_used_at }
  )
}, async (before, { container }) => {
  if (!before) return
  const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
  await service.updateReviewRequests(before)
})

/**
 * A fresh review link for an order, for our team to give a customer who lost
 * theirs, or whose link was used or ran out. The old link stops working. No
 * message is sent.
 */
export const issueReviewLinkWorkflow = createWorkflow("issue-review-link", function (input: { order_id: string }) {
  return new WorkflowResponse(issueReviewLinkStep(input))
})
