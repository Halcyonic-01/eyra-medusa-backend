import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { resolveWebhookSessionStep } from "./steps/resolve-webhook-session"

/** Which Medusa payment session a Razorpay webhook is for, from the backend's own records. Read only. */
export const resolveWebhookSessionWorkflow = createWorkflow(
  "resolve-webhook-session",
  function (input: { razorpay_order_id: string }) {
    return new WorkflowResponse(resolveWebhookSessionStep(input))
  }
)
