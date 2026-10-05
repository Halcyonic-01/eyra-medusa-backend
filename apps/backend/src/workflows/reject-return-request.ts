import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  emitEventStep,
  releaseLockStep,
} from "@medusajs/medusa/core-flows"
import { getPendingReturnRequestStep } from "./steps/get-pending-return-request"
import { resolveReturnRequestStep } from "./steps/resolve-return-request"

export type RejectReturnRequestInput = {
  request_id: string
  /** Shown to the customer, so it should say why. */
  note: string
  rejected_by?: string
}

/** Declines a return or exchange request and tells the customer why. */
export const rejectReturnRequestWorkflow = createWorkflow(
  "reject-return-request",
  function (input: RejectReturnRequestInput) {
    const lockKey = transform({ input }, (data) => `return-request:${data.input.request_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const request = getPendingReturnRequestStep({ request_id: input.request_id })

    const resolved = resolveReturnRequestStep(
      transform({ input }, (data) => ({
        request_id: data.input.request_id,
        status: "rejected" as const,
        resolution_note: data.input.note,
        resolved_by: data.input.rejected_by ?? null,
      }))
    )

    releaseLockStep({ key: lockKey })

    emitEventStep({
      eventName: "return_request.rejected",
      data: transform({ input, request }, (data) => ({
        request_id: data.input.request_id,
        customer_id: data.request.customer_id,
        order_id: data.request.order_id,
        type: data.request.type,
        note: data.input.note,
      })),
    })

    return new WorkflowResponse(resolved)
  }
)
