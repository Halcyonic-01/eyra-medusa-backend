import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, emitEventStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { markReturnReceivedStep } from "./steps/mark-return-received"

export type ReceiveReturnRequestInput = {
  request_id: string
  received_by?: string
}

/**
 * Our team has the item and it passed the quality check. This records it and
 * announces order.return_received, which starts the credit note, the store
 * credit and (for an exchange) the replacement. Run again on a request that was
 * received but not finished, it announces it again, which is how a stuck one
 * is kicked off.
 */
export const receiveReturnRequestWorkflow = createWorkflow(
  "receive-return-request",
  function (input: ReceiveReturnRequestInput) {
    const lockKey = transform({ input }, (data) => `return-request:${data.input.request_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const received = markReturnReceivedStep(input)

    releaseLockStep({ key: lockKey })

    emitEventStep({
      eventName: "order.return_received",
      data: transform({ received }, (data) => ({
        order_id: data.received.order_id,
        return_request_id: data.received.id,
        type: data.received.type,
      })),
    })

    return new WorkflowResponse(received)
  }
)
