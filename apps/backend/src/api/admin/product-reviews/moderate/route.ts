import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { moderateProductReviewsWorkflow } from "../../../../workflows/moderate-product-reviews"
import type { ModerateBody } from "../../../review-validation"

/**
 * POST /admin/product-reviews/moderate  { ids, action: "approve" | "reject", reason?, note? }
 *
 * Approves or rejects one or many reviews. A rejection needs a policy reason and a note.
 */
export async function POST(req: AuthenticatedMedusaRequest<ModerateBody>, res: MedusaResponse) {
  const { result } = await moderateProductReviewsWorkflow(req.scope).run({
    input: { ...req.validatedBody, actor_id: req.auth_context?.actor_id ?? null },
  })
  return res.json({ moderated: result.ids })
}
