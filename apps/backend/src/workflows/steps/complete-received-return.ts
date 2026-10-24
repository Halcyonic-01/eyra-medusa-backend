import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { completeReceivedReturn } from "../../modules/return-request/complete"

/** No undo: a credit note number, a payment of credit and a shipped replacement are never taken back. Each is safe to repeat. */
export const completeReceivedReturnStep = createStep(
  "complete-received-return",
  async (input: { request_id: string }, { container }) => {
    return new StepResponse(await completeReceivedReturn(container, input.request_id))
  }
)
