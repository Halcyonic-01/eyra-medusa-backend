import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { receiveReturnRequestWorkflow } from "../../../../../workflows/receive-return-request"

/**
 * POST /admin/return-requests/:id/received
 *
 * The item reached us and passed the quality check. Announces order.return_received,
 * which issues the credit note and the store credit (or sends the replacement for
 * an exchange). The answer comes back before that finishes; the request shows
 * as approved a moment later. Calling it again on a request that did not finish
 * starts it again.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await receiveReturnRequestWorkflow(req.scope).run({
    input: { request_id: req.params.id, received_by: req.auth_context?.actor_id },
  })
  return res.json({ return_request: result })
}
