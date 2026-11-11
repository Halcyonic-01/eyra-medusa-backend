import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  findEmailCandidates,
  findOrphanOrders,
  findReservationCandidates,
  findUnredeemedWalletOrders,
} from "../modules/order-dispatch/integrity-candidates"
import { nextEmailAttempt } from "../modules/order-dispatch/order-integrity"
import { loadPaymentStanding } from "../modules/order-dispatch/payment-standing"
import { postToStorefront } from "../utils/storefront"
import { redeemWalletForOrderWorkflow } from "../workflows/redeem-wallet-for-order"
import { repairOrderReservationsWorkflow } from "../workflows/repair-order-reservations"
import { voidOrphanOrderWorkflow } from "../workflows/void-orphan-order"

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

/**
 * Every ten minutes, repairs what an interrupted checkout or a lost event can
 * leave behind. Each part is independent and safe to repeat:
 *
 * 1. Leftover orders from an interrupted checkout are voided (no refund, no
 *    order-cancelled event; see void-orphan-order).
 * 2. Missing stock reservations are restored.
 * 3. Wallet credit an order used but never had deducted is deducted (the
 *    deduction is locked per customer and unique per order).
 * 4. Confirmation emails that never went out are retried through the
 *    storefront, which sends each one once (see its email claim).
 */
export default async function recoverOrderIntegrity(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  await safely(logger, "orphans", () => voidOrphans(container, logger))
  await safely(logger, "reservations", () => restoreReservations(container, logger))
  await safely(logger, "wallet", () => finishWalletDeductions(container, logger))
  await safely(logger, "email", () => retryConfirmationEmails(container, logger))
}

async function safely(logger: Logger, part: string, work: () => Promise<void>) {
  try {
    await work()
  } catch (error) {
    logger.error(`[order-integrity] ${part} sweep failed: ${(error as Error).message}`)
  }
}

async function voidOrphans(container: MedusaContainer, logger: Logger) {
  for (const orderId of await findOrphanOrders(container)) {
    const { result, errors } = await voidOrphanOrderWorkflow(container).run({ input: { order_id: orderId }, throwOnError: false })
    if (errors?.length) {
      logger.error(`[order-integrity] could not void ${orderId}: ${(errors[0].error as Error)?.message}`)
      continue
    }
    if (result.voided) {
      await postToStorefront("/api/ops/notify", { type: "order_orphan_voided", order_id: orderId }, logger)
    }
  }
}

async function restoreReservations(container: MedusaContainer, logger: Logger) {
  const orders = container.resolve(Modules.ORDER)
  for (const orderId of await findReservationCandidates(container)) {
    const { result, errors } = await repairOrderReservationsWorkflow(container).run({ input: { order_id: orderId }, throwOnError: false })
    if (errors?.length || !result) {
      logger.error(`[order-integrity] reservations for ${orderId}: ${(errors?.[0]?.error as Error)?.message ?? "no result"}`)
      continue
    }
    if (result.created) logger.warn(`[order-integrity] restored ${result.created} stock reservation(s) for order ${orderId}`)
    if (result.short.length) {
      const [order] = await orders.listOrders({ id: orderId }, { select: ["id", "metadata"] })
      if ((order?.metadata as Record<string, unknown> | null)?.stock_short_alerted) continue
      logger.error(`[order-integrity] order ${orderId} could not be given stock for ${result.short.length} item(s)`)
      const sent = await postToStorefront("/api/ops/notify", { type: "stock_not_reserved", order_id: orderId, items: result.short }, logger)
      if (sent === "sent") await orders.updateOrders({ id: orderId }, { metadata: { stock_short_alerted: true } })
    }
  }
}

async function finishWalletDeductions(container: MedusaContainer, logger: Logger) {
  for (const orderId of await findUnredeemedWalletOrders(container)) {
    const { result, errors } = await redeemWalletForOrderWorkflow(container).run({ input: { order_id: orderId }, throwOnError: false })
    if (errors?.length || !result) {
      const message = (errors?.[0]?.error as Error)?.message ?? "no result"
      logger.error(`[order-integrity] wallet credit for order ${orderId} could not be deducted: ${message}`)
      await postToStorefront("/api/ops/notify", { type: "wallet_redeem_failed", order_id: orderId, error: message }, logger)
      continue
    }
    if (result.redeemed) {
      logger.warn(`[order-integrity] deducted ${result.amount} wallet credit for order ${orderId} after its order-placed event was lost`)
    }
  }
}

/** Asks the storefront to send one order's confirmation email. Status 0 when it could not be reached. */
async function requestConfirmationEmail(orderId: string): Promise<{ status: number; result: string | null }> {
  try {
    const res = await fetch(new URL("/api/orders/confirmation-email", process.env.STOREFRONT_REVALIDATE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-revalidate-secret": process.env.STOREFRONT_REVALIDATE_SECRET ?? "" },
      body: JSON.stringify({ order_id: orderId }),
      signal: AbortSignal.timeout(20000),
    })
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null
    return { status: res.status, result: typeof body?.result === "string" ? body.result : null }
  } catch {
    return { status: 0, result: null }
  }
}

async function retryConfirmationEmails(container: MedusaContainer, logger: Logger) {
  if (!process.env.STOREFRONT_REVALIDATE_URL || !process.env.STOREFRONT_REVALIDATE_SECRET) return
  const orders = container.resolve(Modules.ORDER)
  for (const candidate of await findEmailCandidates(container)) {
    // Never email about an order that is held for a missing payment.
    if (!(await loadPaymentStanding(container, candidate.order_id)).ok) continue

    const { status, result: outcome } = await requestConfirmationEmail(candidate.order_id)
    if (status === 200 && (outcome === "sent" || outcome === "already_sent")) continue
    if (status === 200 && outcome === "skipped") {
      await orders.updateOrders({ id: candidate.order_id }, { metadata: { confirmation_email_gave_up: "email_not_configured" } })
      continue
    }

    // Failed, busy, or the storefront could not be reached: try again later.
    const attempts = candidate.attempts + 1
    const next = nextEmailAttempt(attempts)
    if (next) {
      await orders.updateOrders(
        { id: candidate.order_id },
        { metadata: { confirmation_email_attempts: attempts, confirmation_email_next_at: next.toISOString() } }
      )
      continue
    }
    logger.error(`[order-integrity] confirmation email for order ${candidate.order_id} failed ${attempts} times, giving up`)
    await orders.updateOrders({ id: candidate.order_id }, { metadata: { confirmation_email_attempts: attempts, confirmation_email_gave_up: "failed" } })
    await postToStorefront("/api/ops/notify", { type: "confirmation_email_failed", order_id: candidate.order_id, order_ref: `EYRA-${candidate.display_id}` }, logger)
  }
}

export const config = {
  name: "recover-order-integrity",
  schedule: "*/10 * * * *",
}
