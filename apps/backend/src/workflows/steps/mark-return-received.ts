import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { exchangePaymentDue } from "../../modules/return-request/constants"
import { toNumber } from "../../modules/wallet/utils"
import type ReturnRequestModuleService from "../../modules/return-request/service"

const RECEIVABLE = ["pending", "reverse_pickup_scheduled", "awaiting_inspection"]

export type ReceivedReturn = { id: string; order_id: string; customer_id: string; type: "return" | "exchange"; status: string }

/**
 * Records that the item reached us and passed the check. An exchange whose
 * replacement costs more can only be received once the difference has been paid. A request already finished is refused;
 * one received earlier but not finished is allowed again, to restart it.
 */
export const markReturnReceivedStep = createStep(
  "mark-return-received",
  async (input: { request_id: string; received_by?: string }, { container }) => {
    const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    const [request] = await service.listReturnRequests({ id: input.request_id }, { take: 1 })
    if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")

    if (request.status === "approved" || request.status === "rejected") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `This request was already ${request.status}`)
    }
    if (request.status === "pending_fee") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "The price difference for the exchange has not been paid yet")
    }
    if (!RECEIVABLE.includes(request.status)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `A request that is ${request.status} cannot be received`)
    }
    if (request.type === "exchange" && exchangePaymentDue(toNumber(request.amount_due)) && !request.fee_paid_at) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "The price difference for the exchange has not been paid yet")
    }

    if (!request.received_at) {
      await service.updateReturnRequests({
        id: request.id,
        status: "awaiting_inspection",
        received_at: new Date(),
        received_by: input.received_by ?? null,
      })
    }
    return new StepResponse<ReceivedReturn>({
      id: request.id,
      order_id: request.order_id,
      customer_id: request.customer_id,
      type: request.type,
      status: "awaiting_inspection",
    })
  }
)
