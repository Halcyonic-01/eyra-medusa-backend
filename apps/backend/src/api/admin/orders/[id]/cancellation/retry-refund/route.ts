import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { retryCancellationRefundWorkflow } from "../../../../../../workflows/retry-cancellation-refund"

/**
 * POST /admin/orders/:id/cancellation/retry-refund
 *
 * Staff finish a cancellation whose refund failed or could not be confirmed.
 */
export async function POST(req: AuthenticatedMedusaRequest<unknown>, res: MedusaResponse) {
  const id = req.params.id
  if (typeof id !== "string" || !id.startsWith("order_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid order id is required")
  }

  const { result } = await retryCancellationRefundWorkflow(req.scope).run({
    input: { order_id: id },
  })
  return res.json(result)
}
