import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../../../../../modules/return-request"
import { syncExchangePayment } from "../../../../../modules/return-request/exchange-payment"
import type ReturnRequestModuleService from "../../../../../modules/return-request/service"

/**
 * POST /admin/return-requests/:id/payment-status
 *
 * Asks Razorpay about an exchange's payment link now and acts on the answer,
 * exactly as the webhook would. The storefront calls it when the customer comes
 * back from paying, so the order page is right at once, without waiting for (or
 * depending on) the webhook. Safe to call any number of times.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service: ReturnRequestModuleService = req.scope.resolve(RETURN_REQUEST_MODULE)
  const [request] = await service.listReturnRequests({ id: req.params.id }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")

  const result = await syncExchangePayment(req.scope, request.id)
  const [updated] = await service.listReturnRequests({ id: request.id }, { take: 1 })
  return res.json({
    result,
    return_request: {
      id: updated.id,
      status: updated.status,
      fee_paid_at: updated.fee_paid_at,
      fee_refunded_at: updated.fee_refunded_at,
      reverse_awb: updated.reverse_awb,
    },
  })
}
