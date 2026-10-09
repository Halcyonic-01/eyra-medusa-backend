import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { releaseStalledCancellationStep } from "./steps/release-stalled-cancellation"

/** Staff free an order whose cancellation stopped before any money moved. */
export const releaseStalledCancellationWorkflow = createWorkflow(
  "release-stalled-cancellation",
  function (input: { order_id: string }) {
    const result = releaseStalledCancellationStep(input)
    return new WorkflowResponse(result)
  }
)
