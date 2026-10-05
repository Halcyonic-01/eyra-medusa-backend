import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import type ReturnRequestModuleService from "../../modules/return-request/service"

type Input = {
  request_id: string
  status: "approved" | "rejected"
  credit_amount?: number | null
  resolution_note?: string | null
  resolved_by?: string | null
}

/** Records staff's decision on a request. */
export const resolveReturnRequestStep = createStep(
  "resolve-return-request",
  async (input: Input, { container }) => {
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

    const updated = await requestService.updateReturnRequests({
      id: input.request_id,
      status: input.status,
      credit_amount: input.credit_amount ?? null,
      resolution_note: input.resolution_note ?? null,
      resolved_by: input.resolved_by ?? null,
      resolved_at: new Date(),
    })

    return new StepResponse(updated, input.request_id)
  },
  async (requestId, { container }) => {
    if (!requestId) {
      return
    }
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    await requestService.updateReturnRequests({
      id: requestId,
      status: "pending",
      credit_amount: null,
      resolution_note: null,
      resolved_by: null,
      resolved_at: null,
    })
  }
)
