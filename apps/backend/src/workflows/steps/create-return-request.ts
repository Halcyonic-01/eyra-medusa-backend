import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import type { ReturnRequestReason } from "../../modules/return-request/constants"
import { toStoredItems, type RequestedItem } from "../../modules/return-request/items"
import type ReturnRequestModuleService from "../../modules/return-request/service"

export type ReturnRequestType = "return" | "exchange"
export type { ReturnRequestReason }

type Input = {
  order_id: string
  customer_id: string
  type: ReturnRequestType
  reason: ReturnRequestReason
  note?: string | null
  items: RequestedItem[]
  paid_value: number
  fee_amount: number | null
  delivered_at: string | null
  replacement: {
    variant_id: string
    title: string
    price: number
    price_difference: number
    amount_due: number
  } | null
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
      paid_value: input.paid_value,
      fee_amount: input.fee_amount,
      delivered_at: input.delivered_at ? new Date(input.delivered_at) : null,
      ...(input.replacement
        ? {
            replacement_variant_id: input.replacement.variant_id,
            replacement_title: input.replacement.title,
            replacement_price: input.replacement.price,
            price_difference: input.replacement.price_difference,
            amount_due: input.replacement.amount_due,
          }
        : {}),
    })

    return new StepResponse(request, request.id)
  },
  async (id, { container }) => {
    if (!id) return
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    await requestService.deleteReturnRequests(id)
  }
)
