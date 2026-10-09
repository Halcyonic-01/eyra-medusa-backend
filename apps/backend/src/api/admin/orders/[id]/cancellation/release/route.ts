import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { releaseStalledCancellationWorkflow } from "../../../../../../workflows/release-stalled-cancellation"

/**
 * POST /admin/orders/:id/cancellation/release
 *
 * Staff free an order stuck "cancelling" when no refund was sent.
 */
export async function POST(req: AuthenticatedMedusaRequest<unknown>, res: MedusaResponse) {
  const id = req.params.id
  if (typeof id !== "string" || !id.startsWith("order_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid order id is required")
  }

  const { result } = await releaseStalledCancellationWorkflow(req.scope).run({ input: { order_id: id } })
  return res.json(result)
}
