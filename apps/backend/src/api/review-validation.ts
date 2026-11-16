import { MedusaError } from "@medusajs/framework/utils"
import { MAX_PHOTO_BYTES, REVIEW_STATUSES } from "../modules/product-review/constants"
import type { ReviewInput } from "../modules/product-review/content"
import { SORTS, type ReviewSort } from "../modules/product-review/ratings"

/** Request shapes for the review routes. Content rules live in the module (content.ts). */

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function record(value: unknown, what = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} must be an object`)
  return value as Record<string, unknown>
}

function prefixed(source: Record<string, unknown>, field: string, prefix: string): string {
  const value = source[field]
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length || value.length > 80) {
    invalid(`'${field}' must be an id starting with '${prefix}'`)
  }
  return value as string
}

function token(source: Record<string, unknown>): string {
  const value = source.token
  if (typeof value !== "string" || value.length > 100) invalid("'token' is required")
  return value as string
}

const optionalText = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") invalid("text fields must be text")
  return (value as string).slice(0, max)
}

function reviewsOf(source: Record<string, unknown>): ReviewInput[] {
  if (!Array.isArray(source.reviews) || source.reviews.length === 0 || source.reviews.length > 20) {
    invalid("'reviews' must list between 1 and 20 reviews")
  }
  return (source.reviews as unknown[]).map((entry, index) => {
    const row = record(entry, `reviews[${index}]`)
    const photos = row.photo_ids === undefined ? [] : row.photo_ids
    if (!Array.isArray(photos) || photos.length > 10 || photos.some((id) => typeof id !== "string")) {
      invalid(`reviews[${index}].photo_ids must be a list of ids`)
    }
    return {
      line_item_id: prefixed(row, "line_item_id", "ordli_"),
      rating: Number(row.rating),
      title: optionalText(row.title, 200),
      body: typeof row.body === "string" ? row.body.slice(0, 5000) : "",
      display_name: optionalText(row.display_name, 100),
      photo_ids: photos as string[],
    }
  })
}

export type ReviewLinkBody = { token: string }
export const parseReviewLink = (body: unknown): ReviewLinkBody => ({ token: token(record(body)) })

export type LinkReviewsBody = { token: string; reviews: ReviewInput[] }
export function parseLinkReviews(body: unknown): LinkReviewsBody {
  const source = record(body)
  return { token: token(source), reviews: reviewsOf(source) }
}

export type CustomerReviewsBody = { customer_id: string; order_id: string; reviews: ReviewInput[] }
export function parseCustomerReviews(body: unknown): CustomerReviewsBody {
  const source = record(body)
  return { customer_id: prefixed(source, "customer_id", "cus_"), order_id: prefixed(source, "order_id", "order_"), reviews: reviewsOf(source) }
}

const photoContent = (source: Record<string, unknown>): string => {
  const value = source.content_base64
  if (typeof value !== "string" || !value || value.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) {
    invalid("'content_base64' must be a photo of at most 3 MB")
  }
  return value as string
}

export type LinkPhotoBody = { token: string; content_base64: string }
export function parseLinkPhoto(body: unknown): LinkPhotoBody {
  const source = record(body)
  return { token: token(source), content_base64: photoContent(source) }
}

export type CustomerPhotoBody = { customer_id: string; order_id: string; content_base64: string }
export function parseCustomerPhoto(body: unknown): CustomerPhotoBody {
  const source = record(body)
  return {
    customer_id: prefixed(source, "customer_id", "cus_"),
    order_id: prefixed(source, "order_id", "order_"),
    content_base64: photoContent(source),
  }
}

export type CustomerOrderQuery = { customer_id: string; order_id: string }
export function parseCustomerOrder(query: unknown): CustomerOrderQuery {
  const source = record(query, "query")
  return { customer_id: prefixed(source, "customer_id", "cus_"), order_id: prefixed(source, "order_id", "order_") }
}

const whole = (value: unknown, fallback: number, min: number, max: number): number => {
  if (value === undefined || value === "") return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) invalid(`numbers must be whole, from ${min} to ${max}`)
  return n
}

export type ProductReviewsQuery = { handle?: string; product_id?: string; sort: ReviewSort; limit: number; offset: number }
export function parseProductReviews(query: unknown): ProductReviewsQuery {
  const source = record(query, "query")
  const handle = typeof source.handle === "string" && /^[a-z0-9-]{1,120}$/.test(source.handle) ? source.handle : undefined
  const productId = typeof source.product_id === "string" && source.product_id.startsWith("prod_") ? source.product_id : undefined
  if (!handle && !productId) invalid("'handle' or 'product_id' is required")
  const sort = (source.sort ?? "newest") as ReviewSort
  if (!SORTS.includes(sort)) invalid(`'sort' must be one of: ${SORTS.join(", ")}`)
  return { handle, product_id: productId, sort, limit: whole(source.limit, 10, 1, 50), offset: whole(source.offset, 0, 0, 10000) }
}

export type AdminReviewsQuery = {
  status?: (typeof REVIEW_STATUSES)[number]
  rating?: number
  product_id?: string
  order_id?: string
  flagged?: boolean
  q?: string
  limit: number
  offset: number
}
export function parseAdminReviews(query: unknown): AdminReviewsQuery {
  const source = record(query, "query")
  const status = source.status === undefined || source.status === "" ? undefined : (source.status as AdminReviewsQuery["status"])
  if (status && !REVIEW_STATUSES.includes(status)) invalid(`'status' must be one of: ${REVIEW_STATUSES.join(", ")}`)
  const rating = source.rating === undefined || source.rating === "" ? undefined : whole(source.rating, 0, 1, 5)
  return {
    status,
    rating,
    product_id: typeof source.product_id === "string" && source.product_id ? source.product_id : undefined,
    order_id: typeof source.order_id === "string" && source.order_id ? source.order_id : undefined,
    flagged: source.flagged === "true" ? true : undefined,
    q: typeof source.q === "string" && source.q.trim() ? source.q.trim().slice(0, 100) : undefined,
    limit: whole(source.limit, 20, 1, 100),
    offset: whole(source.offset, 0, 0, 100000),
  }
}

export type ModerateBody = { ids: string[]; action: "approve" | "reject"; reason?: string; note?: string }
export function parseModerate(body: unknown): ModerateBody {
  const source = record(body)
  if (!Array.isArray(source.ids) || !source.ids.length || source.ids.length > 100 || source.ids.some((id) => typeof id !== "string" || !id.startsWith("prev_"))) {
    invalid("'ids' must list 1 to 100 review ids")
  }
  if (source.action !== "approve" && source.action !== "reject") invalid("'action' must be approve or reject")
  return {
    ids: source.ids as string[],
    action: source.action as "approve" | "reject",
    reason: typeof source.reason === "string" ? source.reason : undefined,
    note: typeof source.note === "string" ? source.note.slice(0, 1000) : undefined,
  }
}

export type WhatsappConsentBody = { opt_in: boolean }
export function parseWhatsappConsent(body: unknown): WhatsappConsentBody {
  const source = record(body)
  if (typeof source.opt_in !== "boolean") invalid("'opt_in' must be true or false")
  return { opt_in: source.opt_in as boolean }
}
