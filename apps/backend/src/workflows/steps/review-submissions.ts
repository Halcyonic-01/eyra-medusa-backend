import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_REVIEW_MODULE } from "../../modules/product-review"
import { MAX_PHOTOS_PER_ORDER, type ReviewSource } from "../../modules/product-review/constants"
import { checkReviewInput, displayNameFor, spamFlags, type CleanReview, type ReviewInput } from "../../modules/product-review/content"
import { summarise } from "../../modules/product-review/ratings"
import type ProductReviewModuleService from "../../modules/product-review/service"
import { hashToken, linkState, wellFormedToken } from "../../modules/product-review/tokens"
import { postToStorefront } from "../../utils/storefront"
import { loadReviewOrder, reviewable, type ReviewOrder } from "./review-orders"

const reviews = (container: MedusaContainer): ProductReviewModuleService => container.resolve(PRODUCT_REVIEW_MODULE)

/** Who is reviewing: the holder of a review link, or a signed-in customer the storefront vouches for. */
export type Reviewer = { source: "link"; token: string } | { source: "account"; customer_id: string; order_id: string }

export type ReviewAccess = {
  source: ReviewSource
  order: ReviewOrder
  request: any | null
  customer_key: string
}

const notAllowed = (message: string) => new MedusaError(MedusaError.Types.NOT_ALLOWED, message)

/**
 * Finds the order a reviewer may review, or refuses with a reason the
 * customer can read. A link must be one we issued, unused and in date. A
 * signed-in customer must own the order. Either way the order must have been
 * delivered to them.
 */
export async function resolveReviewAccess(container: MedusaContainer, who: Reviewer, now = new Date()): Promise<ReviewAccess> {
  const service = reviews(container)
  let request: any = null
  let orderId: string
  if (who.source === "link") {
    if (!wellFormedToken(who.token)) throw notAllowed("This review link is not valid.")
    ;[request] = await service.listReviewRequests({ token_hash: hashToken(who.token) }, { take: 1 })
    if (!request) throw notAllowed("This review link is not valid.")
    const state = linkState(request, now)
    if (state === "used") throw notAllowed("This review link has already been used. Sign in and open your order to change a review.")
    if (state === "expired") throw notAllowed("This review link has expired. Sign in and open your order to leave a review.")
    orderId = request.order_id
  } else {
    orderId = who.order_id
    ;[request] = await service.listReviewRequests({ order_id: orderId }, { take: 1 })
  }

  const order = await loadReviewOrder(container, orderId)
  if (who.source === "account" && (!order || order.customer_id !== who.customer_id)) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found.")
  }
  const check = reviewable(order)
  if (!check.ok) {
    throw notAllowed(
      check.reason === "not_delivered"
        ? "You can review your order once it has been delivered."
        : "This order cannot be reviewed."
    )
  }
  const facts = order as ReviewOrder
  const key = facts.customer_id ?? (facts.email ?? "").toLowerCase()
  if (!key) throw notAllowed("This order cannot be reviewed.")
  return { source: who.source, order: facts, request, customer_key: key }
}

export type PlannedReview = CleanReview & {
  product_id: string
  variant_id: string | null
  product_title: string
  variant_title: string | null
  flags: string[]
  existing_id: string | null
}

export type SubmissionPlan = { access: ReviewAccess; reviews: PlannedReview[] }

/** Checks every review against the order and the rules, before anything is saved. */
export async function planSubmission(container: MedusaContainer, who: Reviewer, inputs: ReviewInput[], now = new Date()): Promise<SubmissionPlan> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Rate at least one product.")
  }
  const access = await resolveReviewAccess(container, who, now)
  const service = reviews(container)
  const lines = new Map(access.order.lines.map((line) => [line.id, line]))

  const seenLines = new Set<string>()
  const planned: PlannedReview[] = []
  for (const input of inputs) {
    const line = lines.get(String(input?.line_item_id ?? ""))
    if (!line) throw new MedusaError(MedusaError.Types.INVALID_DATA, "That product is not on this order.")
    if (seenLines.has(line.id)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Each product can be reviewed once.")
    seenLines.add(line.id)
    const checked = checkReviewInput({ ...input, line_item_id: line.id })
    if (!checked.ok) throw new MedusaError(MedusaError.Types.INVALID_DATA, `${line.product_title}: ${checked.error}`)

    const [existing] = await service.listProductReviews({ product_id: line.product_id, customer_key: access.customer_key }, { take: 1 })
    // The photos must be this order's own, and not already on another review.
    if (checked.review.photo_ids.length) {
      const photos = await service.listReviewImages({ id: checked.review.photo_ids }, { take: checked.review.photo_ids.length })
      const usable = photos.filter(
        (photo: any) =>
          photo.order_id === access.order.id &&
          photo.status !== "removed" &&
          (photo.status === "uploaded" || (existing && photo.review_id === existing.id))
      )
      if (usable.length !== checked.review.photo_ids.length) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "One of the photos could not be used. Please upload it again.")
      }
    }
    const others = (await service.listProductReviews({ customer_key: access.customer_key }, { select: ["id", "body"], take: 50 }))
      .filter((other: any) => other.id !== existing?.id)
      .map((other: any) => other.body as string)
    planned.push({
      ...checked.review,
      display_name: checked.review.display_name ?? displayNameFor(access.order.first_name, access.order.last_name),
      product_id: line.product_id,
      variant_id: line.variant_id,
      product_title: line.product_title,
      variant_title: line.variant_title,
      flags: spamFlags(checked.review, others),
      existing_id: existing?.id ?? null,
    })
  }
  return { access, reviews: planned }
}

type Snapshot = { id: string; created: boolean; before: Record<string, unknown> | null; photos_before: { id: string; status: string; review_id: string | null }[] }

/**
 * Saves the reviews: a new one is created, an existing one (the same customer
 * and product) is edited and goes back for checking. Photos left out of an
 * edit are taken off the review.
 */
export const saveProductReviewsStep = createStep(
  "save-product-reviews",
  async (input: { plan: SubmissionPlan }, { container }) => {
    const service = reviews(container)
    const { access } = input.plan
    const now = new Date()
    const saved: { id: string; product_id: string }[] = []
    const snapshots: Snapshot[] = []

    for (const review of input.plan.reviews) {
      const fields = {
        rating: review.rating,
        title: review.title,
        body: review.body,
        display_name: review.display_name as string,
        flags: review.flags.length ? { signals: review.flags } : null,
        status: "pending" as const,
        order_id: access.order.id,
        line_item_id: review.line_item_id,
        variant_id: review.variant_id,
        product_title: review.product_title,
        variant_title: review.variant_title,
        source: access.source,
        rejection_reason: null,
        moderation_note: null,
        moderated_by: null,
        moderated_at: null,
      }
      let id: string
      if (review.existing_id) {
        const before = await service.retrieveProductReview(review.existing_id, { relations: ["photos"] })
        const { photos, ...rest } = before as any
        snapshots.push({
          id: review.existing_id,
          created: false,
          before: rest,
          photos_before: (photos ?? []).map((photo: any) => ({ id: photo.id, status: photo.status, review_id: photo.review_id ?? review.existing_id })),
        })
        await service.updateProductReviews({ id: review.existing_id, ...fields, edited_at: now })
        id = review.existing_id
        const keep = new Set(review.photo_ids)
        const dropped = (photos ?? []).filter((photo: any) => !keep.has(photo.id) && photo.status !== "removed")
        if (dropped.length) {
          await service.updateReviewImages(dropped.map((photo: any) => ({ id: photo.id, status: "removed" as const, review_id: null })))
        }
      } else {
        const created = await service.createProductReviews({
          ...fields,
          product_id: review.product_id,
          customer_id: access.order.customer_id,
          customer_email: access.order.email,
          customer_key: access.customer_key,
          verified_purchase: true,
          submitted_at: now,
        })
        id = created.id
        snapshots.push({ id, created: true, before: null, photos_before: [] })
      }
      if (review.photo_ids.length) {
        const current = await service.listReviewImages({ id: review.photo_ids }, { take: review.photo_ids.length })
        const snap = snapshots[snapshots.length - 1]
        for (const photo of current as any[]) {
          if (!snap.photos_before.some((p) => p.id === photo.id)) {
            snap.photos_before.push({ id: photo.id, status: photo.status, review_id: photo.review_id ?? null })
          }
        }
        await service.updateReviewImages(review.photo_ids.map((photoId) => ({ id: photoId, status: "attached" as const, review_id: id })))
      }
      saved.push({ id, product_id: review.product_id })
    }
    return new StepResponse({ reviews: saved }, snapshots)
  },
  async (snapshots, { container }) => {
    if (!snapshots?.length) return
    const service = reviews(container)
    for (const snap of [...snapshots].reverse()) {
      if (snap.photos_before.length) {
        await service.updateReviewImages(snap.photos_before.map((p) => ({ id: p.id, status: p.status as any, review_id: p.review_id })))
      }
      if (snap.created) await service.deleteProductReviews(snap.id)
      else if (snap.before) {
        const { id, created_at, updated_at, deleted_at, ...restore } = snap.before as any
        await service.updateProductReviews({ id, ...restore })
      }
    }
  }
)

/** The review is in: the link is spent (when it was used) and the reminder is called off. */
export const completeReviewRequestStep = createStep(
  "complete-review-request",
  async (input: { request_id: string | null; source: ReviewSource }, { container }) => {
    if (!input.request_id) return new StepResponse({ cancelled: 0 }, null)
    const service = reviews(container)
    const before = await service.retrieveReviewRequest(input.request_id)
    const now = new Date()
    await service.updateReviewRequests({
      id: input.request_id,
      completed_at: before.completed_at ?? now,
      ...(input.source === "link" ? { token_used_at: before.token_used_at ?? now } : {}),
    })
    const waiting = await service.listReviewNotifications({ request_id: input.request_id, stage: "reminder", status: ["scheduled", "pending", "failed"] })
    if (waiting.length) {
      await service.updateReviewNotifications(waiting.map((row: any) => ({ id: row.id, status: "cancelled" as const, detail: "reviewed" })))
    }
    return new StepResponse(
      { cancelled: waiting.length },
      { id: input.request_id, completed_at: before.completed_at, token_used_at: before.token_used_at, rows: waiting.map((row: any) => ({ id: row.id, status: row.status, detail: row.detail })) }
    )
  },
  async (undo, { container }) => {
    if (!undo) return
    const service = reviews(container)
    await service.updateReviewRequests({ id: undo.id, completed_at: undo.completed_at ?? null, token_used_at: undo.token_used_at ?? null })
    if (undo.rows.length) await service.updateReviewNotifications(undo.rows)
  }
)

/**
 * Writes each product's rating and review count from its approved reviews,
 * and nothing else, onto the product (where the storefront reads them), then
 * asks the storefront to refresh.
 */
export async function recomputeProductRatings(container: MedusaContainer, productIds: string[]): Promise<Record<string, { average: number; count: number }>> {
  const service = reviews(container)
  const products = container.resolve(Modules.PRODUCT)
  const out: Record<string, { average: number; count: number }> = {}
  for (const productId of [...new Set(productIds)]) {
    const approved = await service.listProductReviews({ product_id: productId, status: "approved" }, { select: ["rating"], take: null as any })
    const summary = summarise(approved.map((review: any) => Number(review.rating)))
    const [product] = await products.listProducts({ id: productId }, { select: ["id", "metadata"], take: 1 })
    if (!product) continue
    await products.updateProducts(productId, {
      metadata: { ...((product as any).metadata ?? {}), rating: summary.average, review_count: summary.count },
    })
    out[productId] = { average: summary.average, count: summary.count }
  }
  if (Object.keys(out).length) {
    await postToStorefront("/api/revalidate", { tag: "products", event: "product_review.changed" }, container.resolve(ContainerRegistrationKeys.LOGGER))
  }
  return out
}

export const recomputeProductRatingsStep = createStep("recompute-product-ratings", async (input: { product_ids: string[] }, { container }) => {
  return new StepResponse(await recomputeProductRatings(container, input.product_ids))
})

export const planReviewSubmissionStep = createStep(
  "plan-review-submission",
  async (input: { reviewer: Reviewer; reviews: ReviewInput[] }, { container }) => {
    return new StepResponse(await planSubmission(container, input.reviewer, input.reviews))
  }
)

/** Uploads for an order are capped so one link cannot fill the file storage. */
export async function photoAllowance(container: MedusaContainer, orderId: string): Promise<number> {
  const [, count] = await reviews(container).listAndCountReviewImages({ order_id: orderId }, { take: 1 })
  return MAX_PHOTOS_PER_ORDER - count
}
