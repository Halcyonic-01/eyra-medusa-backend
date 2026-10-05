import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { approveReturnRequestWorkflow } from "../../../../../workflows/approve-return-request"
import type { ApproveReturnRequestBody } from "../../validation"

/**
 * POST /admin/return-requests/:id/approve
 *
 * Approves the request and issues the agreed amount as wallet credit.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<ApproveReturnRequestBody>,
  res: MedusaResponse
) {
  const { result } = await approveReturnRequestWorkflow(req.scope).run({
    input: {
      request_id: req.params.id,
      amount: req.validatedBody.amount,
      note: req.validatedBody.note,
      approved_by: req.auth_context?.actor_id,
    },
  })

  return res.json({ return_request: result })
}
