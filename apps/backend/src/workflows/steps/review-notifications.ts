import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_REVIEW_MODULE } from "../../modules/product-review"
import type ProductReviewModuleService from "../../modules/product-review/service"
import { decideClaim, emailKey, planNotifications, retryAt } from "../../modules/product-review/notifications"
import { hashToken, linkExpiry, linkSecret, linkToken, newNonce, reviewLinkBase, reviewLinkUrl } from "../../modules/product-review/tokens"
import { customerEmailsEnabled } from "../../utils/customer-email"
import { sendStorefrontEmail } from "../../utils/storefront"
import { sendWhatsappOutcome } from "../../utils/whatsapp"
import { loadReviewOrder, reviewable, type ReviewOrder } from "./review-orders"

const reviews = (container: MedusaContainer): ProductReviewModuleService => container.resolve(PRODUCT_REVIEW_MODULE)

/** The link a message carries, rebuilt from the stored nonce. Null when the storefront address is unknown. */
export function linkFor(request: { id: string; token_nonce: string }): string | null {
  const base = reviewLinkBase()
  return base ? reviewLinkUrl(base, linkToken(linkSecret(), request.id, request.token_nonce)) : null
}

export type CreatedRequest = { request_id: string | null; created: boolean; reason?: string }

/**
 * Opens the review request for a delivered order, with its four messages, once.
 * A second call finds the first one; two at the same moment are kept to one by
 * the unique order index.
 */
export async function openReviewRequest(container: MedusaContainer, orderId: string, now = new Date()): Promise<CreatedRequest> {
  const service = reviews(container)
  const [existing] = await service.listReviewRequests({ order_id: orderId }, { take: 1 })
  if (existing) return { request_id: existing.id, created: false }

  const order = await loadReviewOrder(container, orderId)
  const check = reviewable(order)
  if (!check.ok) return { request_id: null, created: false, reason: check.reason }
  const facts = order as ReviewOrder

  const nonce = newNonce()
  let request: { id: string }
  try {
    // The id is needed for the token, so the row is made first with a placeholder hash, then given its real one.
    request = await service.createReviewRequests({
      order_id: orderId,
      customer_id: facts.customer_id,
      email: facts.email,
      phone: facts.phone,
      first_name: facts.first_name,
      whatsapp_opt_in: facts.whatsapp_opt_in,
      delivered_at: facts.delivered_at,
      token_nonce: nonce,
      token_hash: `pending_${nonce}`,
      token_expires_at: linkExpiry(now),
    })
  } catch (error) {
    // Another delivery update made it a moment ago.
    const [raced] = await service.listReviewRequests({ order_id: orderId }, { take: 1 })
    if (raced) return { request_id: raced.id, created: false }
    throw error
  }
  await service.updateReviewRequests({ id: request.id, token_hash: hashToken(linkToken(linkSecret(), request.id, nonce)) })
  await service.createReviewNotifications(
    planNotifications(
      { email: customerEmailsEnabled() ? facts.email : null, whatsapp_number: facts.whatsapp_number, whatsapp_opt_in: facts.whatsapp_opt_in },
      now
    ).map((row) => ({ ...row, request_id: request.id }))
  )
  return { request_id: request.id, created: true }
}

export type DeliveryResult = "sent" | "skipped" | "failed" | "gave_up" | "cancelled" | "waiting" | "done"

/**
 * Sends one message if it is due and nobody has sent it. Runs under a lock on
 * the message, re-reads it inside the lock, and records the outcome before
 * letting go, so two senders (the delivery update and the scheduled job) can
 * never both send it. Never throws for a provider problem: that is recorded and
 * retried later.
 */
export async function deliverReviewNotification(container: MedusaContainer, notificationId: string, now = new Date()): Promise<DeliveryResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = reviews(container)
  let outcome: DeliveryResult = "waiting"
  try {
    await container.resolve(Modules.LOCKING).execute(
      [`review-notification:${notificationId}`],
      async () => {
        outcome = await deliverLocked(container, service, notificationId, now)
      },
      { timeout: 5 }
    )
  } catch (error) {
    logger.warn(`[reviews] message ${notificationId} not sent now: ${(error as Error).message}`)
  }
  return outcome
}

async function deliverLocked(
  container: MedusaContainer,
  service: ProductReviewModuleService,
  notificationId: string,
  now: Date
): Promise<DeliveryResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const row = await service.retrieveReviewNotification(notificationId, { relations: ["request"] })
  const request = (row as any).request
  const decision = decideClaim(row as any, request, now)
  if (decision.action === "done") return "done"
  if (decision.action === "wait") return "waiting"
  if (decision.action === "cancel") {
    await service.updateReviewNotifications({ id: row.id, status: "cancelled", detail: decision.detail })
    return "cancelled"
  }
  if (decision.action === "give_up") {
    await service.updateReviewNotifications({ id: row.id, status: "gave_up", detail: decision.detail })
    logger.error(`[reviews] gave up on the ${row.stage} ${row.channel} for order ${request.order_id}: ${decision.detail}`)
    return "gave_up"
  }

  const link = linkFor(request)
  if (!link) {
    await service.updateReviewNotifications({ id: row.id, status: "skipped", detail: "no_storefront_url" })
    return "skipped"
  }
  // A reminder for a link that can no longer be used would only frustrate.
  if (request.token_used_at || new Date(request.token_expires_at).getTime() <= now.getTime()) {
    await service.updateReviewNotifications({ id: row.id, status: "cancelled", detail: "link_closed" })
    return "cancelled"
  }

  const order = await loadReviewOrder(container, request.order_id)
  if (!order || !reviewable(order).ok) {
    await service.updateReviewNotifications({ id: row.id, status: "cancelled", detail: "order_not_reviewable" })
    return "cancelled"
  }

  const attempts = Number(row.attempts ?? 0) + 1
  await service.updateReviewNotifications({ id: row.id, status: "sending", claimed_at: now, attempts })

  const result = row.channel === "email" ? await sendEmail(container, row.stage, request, order, link) : await sendWhatsappMessage(container, row.stage, order, link)

  if (result.result === "sent") {
    await service.updateReviewNotifications({ id: row.id, status: "sent", sent_at: new Date(), detail: null, next_attempt_at: null })
    return "sent"
  }
  if (result.result === "skipped") {
    await service.updateReviewNotifications({ id: row.id, status: "skipped", detail: result.detail })
    return "skipped"
  }
  await service.updateReviewNotifications({
    id: row.id,
    status: "failed",
    detail: result.detail,
    next_attempt_at: retryAt(attempts, now),
  })
  logger.error(`[reviews] the ${row.stage} ${row.channel} for order ${request.order_id} failed (attempt ${attempts}): ${result.detail}`)
  return "failed"
}

type SendOutcome = { result: "sent" } | { result: "skipped"; detail: string } | { result: "failed"; detail: string }

async function sendEmail(
  container: MedusaContainer,
  stage: "request" | "reminder",
  request: { order_id: string },
  order: ReviewOrder,
  link: string
): Promise<SendOutcome> {
  if (!customerEmailsEnabled()) return { result: "skipped", detail: "emails_disabled" }
  if (!order.email) return { result: "skipped", detail: "no_email" }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const sent = await sendStorefrontEmail(
    "/api/wallet/notify",
    {
      type: stage === "request" ? "review_request" : "review_reminder",
      email: order.email,
      first_name: order.first_name,
      order_id: order.id,
      order_number: order.display_id,
      review_url: link,
      products: order.lines.slice(0, 6).map((line) => ({
        title: line.product_title,
        variant: line.variant_title,
        thumbnail: line.thumbnail,
      })),
      idempotency_key: emailKey(stage, request.order_id),
    },
    logger
  )
  if (sent === "sent") return { result: "sent" }
  if (sent === "skipped") return { result: "skipped", detail: "storefront_not_configured" }
  return { result: "failed", detail: "email_not_sent" }
}

async function sendWhatsappMessage(container: MedusaContainer, stage: "request" | "reminder", order: ReviewOrder, link: string): Promise<SendOutcome> {
  if (!order.whatsapp_opt_in) return { result: "skipped", detail: "no_consent" }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const first = order.lines[0]?.product_title ?? "your order"
  const product = order.lines.length > 1 ? `${first} and ${order.lines.length - 1} more` : first
  return sendWhatsappOutcome(logger, {
    template: stage === "request" ? "review_request" : "review_reminder",
    phone: order.phone,
    name: order.first_name,
    params: { name: order.first_name ?? "there", product, link, order: order.display_id },
  })
}

/**
 * Every message that may be due: new requests, reminders whose day has come,
 * failures waiting for a retry, and sends that went quiet. The filters are
 * broad on purpose; decideClaim makes the real decision under the lock.
 */
export async function dueNotificationIds(container: MedusaContainer, now: Date, requestIds?: string[]): Promise<string[]> {
  const service = reviews(container)
  const filters: Record<string, unknown> = {
    status: ["pending", "scheduled", "failed", "sending"],
    due_at: { $lte: now },
  }
  if (requestIds?.length) filters.request_id = requestIds
  const rows = await service.listReviewNotifications(filters, { select: ["id"], take: 500, order: { due_at: "ASC" } })
  return rows.map((row) => row.id)
}

export async function sendDueReviewNotifications(container: MedusaContainer, now = new Date(), requestIds?: string[]) {
  const counts: Record<DeliveryResult, number> = { sent: 0, skipped: 0, failed: 0, gave_up: 0, cancelled: 0, waiting: 0, done: 0 }
  for (const id of await dueNotificationIds(container, now, requestIds)) {
    counts[await deliverReviewNotification(container, id, now)] += 1
  }
  return counts
}

export const openReviewRequestStep = createStep("open-review-request", async (input: { order_id: string }, { container }) => {
  return new StepResponse(await openReviewRequest(container, input.order_id))
})

export const sendDueReviewNotificationsStep = createStep(
  "send-due-review-notifications",
  async (input: { request_ids?: string[]; all?: boolean }, { container }) => {
    // Only the scheduled job sends everything that is due; a caller naming no request sends nothing.
    if (!input.all && !input.request_ids?.length) {
      return new StepResponse({ sent: 0, skipped: 0, failed: 0, gave_up: 0, cancelled: 0, waiting: 0, done: 0 })
    }
    return new StepResponse(await sendDueReviewNotifications(container, new Date(), input.all ? undefined : input.request_ids))
  }
)
