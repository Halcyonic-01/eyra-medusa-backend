import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { rejectReturnRequestWorkflow } from "../../../../../workflows/reject-return-request"
import type { RejectReturnRequestBody } from "../../validation"

/**
 * POST /admin/return-requests/:id/reject
 *
 * Declines the request. The note is emailed to the customer.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<RejectReturnRequestBody>,
  res: MedusaResponse
) {
  const { result } = await rejectReturnRequestWorkflow(req.scope).run({
    input: {
      request_id: req.params.id,
      note: req.validatedBody.note,
      rejected_by: req.auth_context?.actor_id,
    },
  })

  return res.json({ return_request: result })
}
