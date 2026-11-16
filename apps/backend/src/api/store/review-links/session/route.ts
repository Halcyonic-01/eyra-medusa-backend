import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { openReviewLinkWorkflow } from "../../../../workflows/open-review-link"
import type { ReviewLinkBody } from "../../../review-validation"

/**
 * POST /store/review-links/session  { token }
 *
 * What the review page shows for a link. The token travels in the body, not
 * the address, so it does not end up in access logs.
 */
export async function POST(req: MedusaRequest<ReviewLinkBody>, res: MedusaResponse) {
  const { result } = await openReviewLinkWorkflow(req.scope).run({ input: { token: req.validatedBody.token } })
  res.setHeader("Cache-Control", "no-store")
  return res.status(result.state === "invalid" ? 404 : 200).json({ session: result })
}
