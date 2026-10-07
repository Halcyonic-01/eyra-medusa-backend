import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { closeOrderDispatchStep } from "./steps/close-order-dispatch"

export type CloseOrderDispatchInput = {
  order_id: string
}

/** Stops a cancelled order from being shipped, when its shipment is not created yet. */
export const closeOrderDispatchWorkflow = createWorkflow(
  "close-order-dispatch",
  function (input: CloseOrderDispatchInput) {
    const result = closeOrderDispatchStep(input)
    return new WorkflowResponse(result)
  }
)
