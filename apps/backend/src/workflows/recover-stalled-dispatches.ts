import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { recoverStalledDispatchesStep } from "./steps/recover-stalled-dispatches"

/** Frees orders whose dispatch was interrupted, so they are retried. */
export const recoverStalledDispatchesWorkflow = createWorkflow(
  "recover-stalled-dispatches",
  function () {
    const result = recoverStalledDispatchesStep()
    return new WorkflowResponse(result)
  }
)
