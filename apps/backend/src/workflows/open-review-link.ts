import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { openReviewLinkStep } from "./steps/review-session"

/** The review page for a link: the order's products and any reviews already given. */
export const openReviewLinkWorkflow = createWorkflow("open-review-link", function (input: { token: string }) {
  return new WorkflowResponse(openReviewLinkStep(input))
})
