import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { issueReviewLinkWorkflow } from "../../../../../../workflows/issue-review-link"

/**
 * POST /admin/orders/:id/review-request/link
 *
 * A fresh review link to give the customer by hand. The earlier link stops
 * working. Nothing is sent to the customer.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await issueReviewLinkWorkflow(req.scope).run({ input: { order_id: req.params.id } })
  return res.json({ url: result.url, expires_at: result.expires_at })
}
