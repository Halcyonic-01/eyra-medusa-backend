import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRODUCT_REVIEW_MODULE } from "../../../modules/product-review"
import { sortOrder, summarise } from "../../../modules/product-review/ratings"
import { publicReview } from "../../../modules/product-review/public"
import type ProductReviewModuleService from "../../../modules/product-review/service"
import type { ProductReviewsQuery } from "../../review-validation"

/**
 * GET /store/product-reviews?handle=&sort=newest|highest|lowest&limit=&offset=
 *
 * A product's approved reviews, with the average, the count and how many of each
 * star rating, all from approved reviews only.
 */
export async function GET(req: MedusaRequest<unknown, ProductReviewsQuery>, res: MedusaResponse) {
  const params = req.validatedQuery as unknown as ProductReviewsQuery
  let productId = params.product_id
  if (!productId && params.handle) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "product", fields: ["id"], filters: { handle: params.handle } })
    productId = (data[0] as any)?.id
  }
  const empty = {
    product_id: productId ?? null,
    summary: summarise([]),
    photo_count: 0,
    reviews: [],
    count: 0,
    offset: params.offset,
    limit: params.limit,
  }
  if (!productId) return res.json(empty)

  const service: ProductReviewModuleService = req.scope.resolve(PRODUCT_REVIEW_MODULE)
  const approved = { product_id: productId, status: "approved" as const }
  const all = await service.listProductReviews(approved, { select: ["id", "rating"], relations: ["photos"], take: null as any })
  const [page, count] = await service.listAndCountProductReviews(approved, {
    relations: ["photos"],
    order: sortOrder(params.sort),
    skip: params.offset,
    take: params.limit,
  })
  res.setHeader("Cache-Control", "public, max-age=60")
  return res.json({
    product_id: productId,
    summary: summarise(all.map((review: any) => Number(review.rating))),
    photo_count: all.reduce((n: number, review: any) => n + (review.photos ?? []).filter((p: any) => p.status === "attached").length, 0),
    reviews: page.map(publicReview),
    count,
    offset: params.offset,
    limit: params.limit,
  })
}
