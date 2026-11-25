import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { ORDER_DISPATCH_MODULE } from "../order-dispatch"
import { loadCancellationContext } from "../order-dispatch/cancellation-context"
import { getRefundGateway, type RefundOutcome } from "../order-dispatch/refund-gateway"
import type OrderDispatchModuleService from "../order-dispatch/service"
import { postToStorefront } from "../../utils/storefront"
import { alertOps, type LateRow } from "./late-payments"
import type PaymentSnapshotModuleService from "./service"

/**
 * A refund the provider accepted is not money back yet: Razorpay and PayU pay
 * it out over days and can still fail it (a closed account, a bank reversal).
 * This follows every accepted refund until the provider reports it paid out.
 *
 * - Late-payment refunds the provider failed go back to "refunding", so the
 *   late-payment sweep sends them again (a failed refund never counts as one
 *   already made, so exactly one live refund exists at a time).
 * - Cancellation refunds it failed become "failed" and the team is told; staff
 *   retry them, as with any cancellation refund that failed.
 * - One still not paid out after VERIFY_DAYS goes to a person.
 */

/** Providers pay out normal-speed refunds within about a week. */
export const VERIFY_DAYS = 14
/** How often the same refund is asked about. */
export const RECHECK_MINUTES = 30
const BATCH = 50

export type VerifyResult = { checked: number; processed: number; failed: number; pending: number; unknown: number; review: number }

type Clock = { now: Date; refundId?: string }

const fresh = (): VerifyResult => ({ checked: 0, processed: 0, failed: 0, pending: 0, unknown: 0, review: 0 })
const tally = (result: VerifyResult, outcome: RefundOutcome) => {
  result.checked += 1
  result[outcome] += 1
}
const dueBefore = (clock: Clock) => new Date(clock.now.getTime() - RECHECK_MINUTES * 60 * 1000)
const tooOld = (since: Date | string | null | undefined, clock: Clock) =>
  Boolean(since) && clock.now.getTime() - new Date(since as Date).getTime() > VERIFY_DAYS * 24 * 3600 * 1000

type Row = LateRow & { refund_id: string | null; resolved_at: Date | string | null; refund_checked_at: Date | string | null; last_error: string | null }

export async function verifyLateRefunds(container: MedusaContainer, clock: Clock = { now: new Date() }): Promise<VerifyResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const filters: Record<string, unknown> = { status: "refunded", refund_verified_at: null, refund_id: clock.refundId ?? { $ne: null } }
  if (!clock.refundId) filters.$or = [{ refund_checked_at: null }, { refund_checked_at: { $lt: dueBefore(clock) } }]
  const rows = (await service.listLateRazorpayPayments(filters as never, { order: { refund_checked_at: "ASC NULLS FIRST" }, take: BATCH })) as unknown as Row[]

  const result = fresh()
  for (const row of rows) {
    const outcome = await getRefundGateway(row.provider_id).refundStatus({
      payment_ref: row.provider_payment_ref ?? row.razorpay_payment_id,
      attempt_ref: row.provider_ref ?? row.razorpay_order_id,
      refund_id: row.refund_id as string,
    })
    tally(result, outcome)
    if (outcome === "processed") {
      await service.updateLateRazorpayPayments({ id: row.id, refund_verified_at: clock.now, refund_checked_at: clock.now })
      continue
    }
    if (outcome === "failed") {
      // Back to owed: the late-payment sweep refunds it again; the failed refund is not counted as made.
      await service.updateLateRazorpayPayments({
        id: row.id,
        status: "refunding",
        refund_checked_at: clock.now,
        resolved_at: null,
        last_error: `The provider failed refund ${row.refund_id}; refunding again`.slice(0, 500),
      })
      logger.error(`[refund-verify] ${row.provider_id} failed refund ${row.refund_id} of cart ${row.cart_id}; it will be sent again`)
      continue
    }
    if (tooOld(row.resolved_at, clock)) {
      await service.updateLateRazorpayPayments({
        id: row.id,
        status: "needs_review",
        refund_checked_at: clock.now,
        last_error: `Refund ${row.refund_id} not paid out after ${VERIFY_DAYS} days (${outcome})`,
      })
      await alertOps(container, { ...row, status: "needs_review" }, "needs_review", `Refund ${row.refund_id} is still not paid out after ${VERIFY_DAYS} days.`)
      result.review += 1
      continue
    }
    await service.updateLateRazorpayPayments({ id: row.id, refund_checked_at: clock.now })
  }
  return result
}

type Cancellation = {
  id: string
  order_id: string
  razorpay_refund_id: string | null
  refund_amount: number
  completed_at: Date | string | null
  created_at: Date | string
}

export async function verifyCancellationRefunds(container: MedusaContainer, clock: Clock = { now: new Date() }): Promise<VerifyResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(ORDER_DISPATCH_MODULE) as OrderDispatchModuleService
  const filters: Record<string, unknown> = {
    refund_method: "original",
    refund_status: "initiated",
    refund_verified_at: null,
    razorpay_refund_id: clock.refundId ?? { $ne: null },
  }
  if (!clock.refundId) filters.$or = [{ refund_checked_at: null }, { refund_checked_at: { $lt: dueBefore(clock) } }]
  const rows = (await service.listOrderCancellations(filters as never, { order: { refund_checked_at: "ASC NULLS FIRST" }, take: BATCH })) as unknown as Cancellation[]

  const result = fresh()
  for (const row of rows) {
    const context = await loadCancellationContext(container, row.order_id)
    const gateway = getRefundGateway(context?.online_provider_id ?? undefined)
    const outcome = await gateway.refundStatus({
      payment_ref: context?.payment_ref ?? null,
      attempt_ref: context?.attempt_ref ?? null,
      refund_id: row.razorpay_refund_id as string,
    })
    tally(result, outcome)
    if (outcome === "processed") {
      await service.updateOrderCancellations({ id: row.id, refund_verified_at: clock.now, refund_checked_at: clock.now })
      continue
    }
    const stale = outcome !== "failed" && tooOld(row.completed_at ?? row.created_at, clock)
    if (outcome === "failed" || stale) {
      const why = outcome === "failed"
        ? `The provider failed refund ${row.razorpay_refund_id}`
        : `Refund ${row.razorpay_refund_id} not paid out after ${VERIFY_DAYS} days`
      // "failed" is what staff retry from; the retry sends a new refund (a failed one never counts).
      await service.updateOrderCancellations({
        id: row.id,
        refund_status: outcome === "failed" ? "failed" : "unverified",
        status: "needs_attention",
        refund_error: why,
        refund_checked_at: clock.now,
      })
      logger.error(`[refund-verify] order ${row.order_id}: ${why}`)
      const state = await gateway.paymentRefundState(context?.payment_ref ?? null, context?.attempt_ref ?? null)
      await postToStorefront(
        "/api/ops/notify",
        {
          type: "refund_missing_after_cancel",
          order_id: row.order_id,
          order_ref: context ? `EYRA-${context.display_id}` : undefined,
          amount: state.status === "known" ? state.amount : null,
          refunded: state.status === "known" ? state.refunded : null,
          checked: state.status === "known",
        },
        logger
      )
      if (stale) result.review += 1
      continue
    }
    await service.updateOrderCancellations({ id: row.id, refund_checked_at: clock.now })
  }
  return result
}

/** Both kinds; one refund id when a provider's webhook names it. */
export async function verifyRefunds(container: MedusaContainer, clock: Clock = { now: new Date() }) {
  return { late: await verifyLateRefunds(container, clock), cancellations: await verifyCancellationRefunds(container, clock) }
}
