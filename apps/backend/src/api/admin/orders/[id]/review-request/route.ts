import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRODUCT_REVIEW_MODULE } from "../../../../../modules/product-review"
import type ProductReviewModuleService from "../../../../../modules/product-review/service"

/**
 * GET /admin/orders/:id/review-request
 *
 * The order's review request for the order page: whether the link was opened
 * and used, each message and how it went, and the reviews it brought in.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service: ProductReviewModuleService = req.scope.resolve(PRODUCT_REVIEW_MODULE)
  const [request] = await service.listReviewRequests({ order_id: req.params.id }, { relations: ["notifications"], take: 1 })
  const reviews = await service.listProductReviews(
    { order_id: req.params.id },
    { select: ["id", "product_title", "rating", "status", "submitted_at"], take: 50 }
  )
  if (!request) return res.json({ review_request: null, reviews })
  const { token_hash, token_nonce, ...safe } = request as any
  return res.json({
    review_request: {
      ...safe,
      notifications: ((request as any).notifications ?? []).map((n: any) => ({
        id: n.id,
        stage: n.stage,
        channel: n.channel,
        status: n.status,
        due_at: n.due_at,
        sent_at: n.sent_at,
        attempts: n.attempts,
        detail: n.detail,
      })),
    },
    reviews,
  })
}
