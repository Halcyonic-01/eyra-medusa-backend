import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { confirmationEmailStep, type ConfirmationEmailAction } from "./steps/confirmation-email-claim"

/** The once-only gate around the order confirmation email (claim, then sent or release). */
export const confirmationEmailWorkflow = createWorkflow(
  "confirmation-email",
  function (input: { order_id: string; action: ConfirmationEmailAction }) {
    return new WorkflowResponse(confirmationEmailStep(input))
  }
)
