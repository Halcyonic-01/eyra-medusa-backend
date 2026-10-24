import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { completeReceivedReturnStep } from "./steps/complete-received-return"

/**
 * Finishes a return or exchange whose item has been received and passed the
 * check: the credit note, the store credit and, for an exchange, the replacement.
 * Locked per request, so the event handler, the retry job and a staff retry can
 * never run it at the same time.
 */
export const completeReceivedReturnWorkflow = createWorkflow(
  "complete-received-return",
  function (input: { request_id: string }) {
    const lockKey = transform({ input }, (data) => `return-request:${data.input.request_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })

    const completed = completeReceivedReturnStep({ request_id: input.request_id })

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(completed)
  }
)
