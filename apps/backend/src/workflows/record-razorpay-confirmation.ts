import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { recordRazorpayConfirmationStep, type RecordRazorpayConfirmationInput } from "./steps/record-razorpay-confirmation"

/** Records which Razorpay payment paid for the order a cart became. Safe to repeat. */
export const recordRazorpayConfirmationWorkflow = createWorkflow(
  "record-razorpay-confirmation",
  function (input: RecordRazorpayConfirmationInput) {
    return new WorkflowResponse(recordRazorpayConfirmationStep(input))
  }
)
