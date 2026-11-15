import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRODUCT_REVIEW_MODULE } from "../../../modules/product-review"
import { REJECTION_LABELS } from "../../../modules/product-review/constants"
import type ProductReviewModuleService from "../../../modules/product-review/service"
import type { AdminReviewsQuery } from "../../review-validation"

/**
 * GET /admin/product-reviews?status=&rating=&product_id=&order_id=&flagged=&q=&limit=&offset=
 *
 * Reviews for moderation, newest first, with who wrote them and which order
 * proves the purchase.
 */
export async function GET(req: AuthenticatedMedusaRequest<unknown, AdminReviewsQuery>, res: MedusaResponse) {
  const params = req.validatedQuery as unknown as AdminReviewsQuery
  const service: ProductReviewModuleService = req.scope.resolve(PRODUCT_REVIEW_MODULE)
  const filters: Record<string, unknown> = {}
  if (params.status) filters.status = params.status
  if (params.rating) filters.rating = params.rating
  if (params.product_id) filters.product_id = params.product_id
  if (params.order_id) filters.order_id = params.order_id
  if (params.flagged) filters.flags = { $ne: null }
  if (params.q) {
    const like = { $ilike: `%${params.q.replace(/[%_]/g, "")}%` }
    filters.$or = [{ body: like }, { title: like }, { display_name: like }, { customer_email: like }, { product_title: like }]
  }
  const [rows, count] = await service.listAndCountProductReviews(filters, {
    relations: ["photos"],
    order: { submitted_at: "DESC" },
    skip: params.offset,
    take: params.limit,
  })

  const orderIds = [...new Set(rows.map((row: any) => row.order_id as string))]
  const numbers = new Map<string, number>()
  if (orderIds.length) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderIds } })
    for (const order of data as any[]) numbers.set(order.id, Number(order.display_id))
  }
  const counts = Object.fromEntries(
    await Promise.all(
      (["pending", "approved", "rejected"] as const).map(async (status) => {
        const [, n] = await service.listAndCountProductReviews({ status }, { take: 1 })
        return [status, n]
      })
    )
  )

  return res.json({
    reviews: rows.map((row: any) => ({
      ...row,
      rating: Number(row.rating),
      order_display_id: numbers.get(row.order_id) ?? null,
      photos: (row.photos ?? []).filter((photo: any) => photo.status !== "removed").map((photo: any) => ({ id: photo.id, url: photo.url, status: photo.status })),
    })),
    count,
    offset: params.offset,
    limit: params.limit,
    counts,
    rejection_reasons: REJECTION_LABELS,
  })
}
