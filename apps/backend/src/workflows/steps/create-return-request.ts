import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { toStoredItems, type RequestedItem } from "../../modules/return-request/items"
import type ReturnRequestModuleService from "../../modules/return-request/service"

export type ReturnRequestType = "return" | "exchange"

export type ReturnRequestReason =
  | "wrong_size"
  | "damaged_or_defective"
  | "not_as_described"
  | "changed_mind"
  | "other"

type Input = {
  order_id: string
  customer_id: string
  type: ReturnRequestType
  reason: ReturnRequestReason
  note?: string | null
  items: RequestedItem[]
}

export const createReturnRequestStep = createStep(
  "create-return-request",
  async (input: Input, { container }) => {
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

    const request = await requestService.createReturnRequests({
      order_id: input.order_id,
      customer_id: input.customer_id,
      type: input.type,
      reason: input.reason,
      note: input.note ?? null,
      items: toStoredItems(input.items),
      status: "pending",
    })

    return new StepResponse(request, request.id)
  },
  async (id, { container }) => {
    if (!id) {
      return
    }
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    await requestService.deleteReturnRequests(id)
  }
)
