import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_REVIEW_MODULE } from "../../modules/product-review"
import { displayNameFor } from "../../modules/product-review/content"
import type ProductReviewModuleService from "../../modules/product-review/service"
import { hashToken, linkState, wellFormedToken, type LinkState } from "../../modules/product-review/tokens"
import { loadReviewOrder, reviewable, type ReviewOrder } from "./review-orders"

export type SessionItem = {
  line_item_id: string
  product_id: string
  title: string
  variant: string | null
  handle: string | null
  thumbnail: string | null
  review: {
    id: string
    rating: number
    title: string | null
    body: string
    display_name: string
    status: string
    photos: { id: string; url: string }[]
  } | null
}

export type ReviewSession =
  | { state: "invalid" }
  | {
      state: LinkState | "not_reviewable"
      order_id: string
      order_number: number
      first_name: string | null
      suggested_name: string
      expires_at: string | null
      items: SessionItem[]
    }

/** The products on an order, each with the customer's review of it when there is one. */
export async function sessionItems(container: MedusaContainer, order: ReviewOrder): Promise<SessionItem[]> {
  const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
  const key = order.customer_id ?? (order.email ?? "").toLowerCase()
  const existing = key
    ? await service.listProductReviews(
        { customer_key: key, product_id: order.lines.map((line) => line.product_id) },
        { relations: ["photos"], take: order.lines.length }
      )
    : []
  return order.lines.map((line) => {
    const review = existing.find((r: any) => r.product_id === line.product_id) as any
    return {
      line_item_id: line.id,
      product_id: line.product_id,
      title: line.product_title,
      variant: line.variant_title,
      handle: line.product_handle,
      thumbnail: line.thumbnail,
      review: review
        ? {
            id: review.id,
            rating: Number(review.rating),
            title: review.title ?? null,
            body: review.body,
            display_name: review.display_name,
            status: review.status,
            photos: (review.photos ?? [])
              .filter((photo: any) => photo.status === "attached")
              .map((photo: any) => ({ id: photo.id, url: photo.url })),
          }
        : null,
    }
  })
}

export async function buildSession(container: MedusaContainer, order: ReviewOrder, state: ReviewSession["state"], expiresAt: Date | null): Promise<ReviewSession> {
  return {
    state: reviewable(order).ok ? (state as any) : "not_reviewable",
    order_id: order.id,
    order_number: order.display_id,
    first_name: order.first_name,
    suggested_name: displayNameFor(order.first_name, order.last_name),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    items: await sessionItems(container, order),
  }
}

/**
 * What the review page shows for a link, and the first time it is opened is
 * noted. An unknown token says only "invalid", so links cannot be guessed at.
 */
export const openReviewLinkStep = createStep("open-review-link", async (input: { token: string }, { container }) => {
  if (!wellFormedToken(input.token)) return new StepResponse({ state: "invalid" } as ReviewSession)
  const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
  const [request] = await service.listReviewRequests({ token_hash: hashToken(input.token) }, { take: 1 })
  if (!request) return new StepResponse({ state: "invalid" } as ReviewSession)
  const order = await loadReviewOrder(container, request.order_id)
  if (!order) return new StepResponse({ state: "invalid" } as ReviewSession)
  const state = linkState(request as any)
  if (state === "ok" && !request.opened_at) await service.updateReviewRequests({ id: request.id, opened_at: new Date() })
  return new StepResponse(await buildSession(container, order, state, new Date(request.token_expires_at as any)))
})
