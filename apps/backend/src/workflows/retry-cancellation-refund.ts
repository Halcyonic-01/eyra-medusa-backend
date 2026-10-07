import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { retryCancellationRefundStep } from "./steps/retry-cancellation-refund"

export type RetryCancellationRefundInput = {
  order_id: string
}

/**
 * Staff finish a cancellation whose refund failed or could not be confirmed.
 * One retry per order at a time, so two clicks cannot both send a refund.
 */
export const retryCancellationRefundWorkflow = createWorkflow(
  "retry-cancellation-refund",
  function (input: RetryCancellationRefundInput) {
    const lockKey = transform({ input }, (data) => `cancellation-retry:${data.input.order_id}`)
    acquireLockStep({ key: lockKey, timeout: 2, ttl: 120 })
    const result = retryCancellationRefundStep(input)
    releaseLockStep({ key: lockKey })
    return new WorkflowResponse(result)
  }
)
