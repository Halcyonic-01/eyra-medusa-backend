import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { fromStoredItems, type RequestedItem } from "../../modules/return-request/items"
import type ReturnRequestModuleService from "../../modules/return-request/service"
import { toNumber } from "../../modules/wallet/utils"

type Input = {
  request_id: string
}

export type PendingReturnRequest = {
  id: string
  order_id: string
  customer_id: string
  type: "return" | "exchange"
  items: RequestedItem[]
  items_total: number
}

/** Loads a request that staff may still decide on. */
export const getPendingReturnRequestStep = createStep(
  "get-pending-return-request",
  async (input: Input, { container }) => {
    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

    const [request] = await requestService.listReturnRequests({ id: input.request_id }, { take: 1 })
    if (!request) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
    }
    if (request.status !== "pending") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `This request was already ${request.status}`
      )
    }

    const items = fromStoredItems(request.items)
    const pending: PendingReturnRequest = {
      id: request.id,
      order_id: request.order_id,
      customer_id: request.customer_id,
      type: request.type,
      items,
      items_total: toNumber(items.reduce((sum, item) => sum + item.total, 0)),
    }
    return new StepResponse(pending)
  }
)
