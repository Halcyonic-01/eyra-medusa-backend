import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../../../../../modules/return-request"
import { exchangePaymentDue } from "../../../../../modules/return-request/constants"
import { toNumber } from "../../../../../modules/wallet/utils"
import type ReturnRequestModuleService from "../../../../../modules/return-request/service"
import { bookPickupFor } from "../../../../../workflows/steps/start-return-flow"

/**
 * POST /admin/return-requests/:id/retry-pickup
 *
 * Books the courier again for a request whose pickup could not be booked (or
 * that waited for our team because delivery was not confirmed). An exchange whose
 * replacement costs more needs the difference paid first. Nothing is booked twice: a request that has a pickup keeps it.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service: ReturnRequestModuleService = req.scope.resolve(RETURN_REQUEST_MODULE)
  const [request] = await service.listReturnRequests({ id: req.params.id }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
  if (request.status !== "pending") {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `A request that is ${request.status} does not need a pickup`)
  }
  if (request.type === "exchange" && exchangePaymentDue(toNumber(request.amount_due)) && !request.fee_paid_at) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "The price difference for the exchange has not been paid yet")
  }

  const outcome = await bookPickupFor(req.scope, request.id)
  const [updated] = await service.listReturnRequests({ id: request.id }, { take: 1 })
  return res.json({ outcome, return_request: { id: updated.id, status: updated.status, reverse_error: updated.reverse_error, reverse_awb: updated.reverse_awb } })
}
