import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import { BLOCK_MESSAGES, type BlockCode, type CancellationContext } from "../../modules/order-dispatch/cancellation"
import { getRefundGateway } from "../../modules/order-dispatch/refund-gateway"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import {
  markCancelled,
  markCancelling,
  noteCancellationProblem,
  releaseCancelling,
  type Pg,
} from "../../modules/order-dispatch/transitions"
import { postToStorefront } from "../../utils/storefront"
import { cancelOrderRecordsWorkflow } from "../cancel-order-records"
import { creditWalletForCancellationWorkflow } from "../credit-wallet-for-cancellation"
import type { PlannedCancellation } from "./plan-cancellation"

type Input = {
  context: CancellationContext
  planned: PlannedCancellation
  customer_id: string
  reason: string
  note?: string | null
}

export type CancellationOutcome = {
  cancellation_id: string
  order_id: string
  refund_method: "wallet" | "original" | "none"
  paid_online: number
  wallet_used: number
  fee: number
  refund_amount: number
  refund_status: "not_needed" | "initiated" | "credited" | "failed" | "unverified"
  status: "completed" | "needs_attention"
  refund_error: string | null
  wallet_expires_at: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function blocked(code: BlockCode): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, BLOCK_MESSAGES[code], code)
}

/** Cancels the order's own records, trying a few times before giving up. */
async function cancelOrderRecords(
  container: Parameters<typeof cancelOrderRecordsWorkflow>[0],
  orderId: string
): Promise<{ ok: boolean; error: string | null }> {
  let lastError: string | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { errors } = await cancelOrderRecordsWorkflow(container).run({
      input: { order_id: orderId },
      throwOnError: false,
    })
    if (errors.length === 0) {
      return { ok: true, error: null }
    }
    lastError = errors[0].error?.message ?? "Unknown error"
    await sleep(300 * attempt)
  }
  return { ok: false, error: lastError }
}

/**
 * Carries out one customer cancellation, in an order that never leaves the
 * customer worse off than the choice they made:
 *
 *  1. Take the order from the dispatcher with one atomic switch. If the shipment
 *     is already being created, or the window has closed, nothing happens.
 *  2. Wallet refund: cancel the order, then credit the wallet. The credit is
 *     idempotent, so if it fails it can simply be retried.
 *     Bank refund: send the refund first, then cancel the order. If Razorpay
 *     clearly refuses, nothing was changed, so the order goes back to normal.
 *     If the answer is unclear, the order stays held and staff are told at once.
 *  3. Close the dispatch record and the cancellation record.
 *
 * Failures after money has moved never undo the cancellation: they are recorded
 * as "needs attention" for staff, with an alert.
 */
export const executeCancellationStep = createStep(
  "execute-cancellation",
  async (input: Input, { container }) => {
    const { context, planned } = input
    const orderId = context.order_id
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const startedAt = Date.now()

    // 1. The atomic switch.
    const claimed = await markCancelling(pg, orderId)
    if (!claimed) {
      const [row] = await service.listOrderDispatches({ order_id: orderId }, { take: 1 })
      if (row?.state === "shipped") blocked("shipment_created")
      if (row?.state === "cancelled" || row?.state === "cancelling") blocked("already_cancelled")
      blocked("preparing")
    }

    // From here on the order is claimed, so every way out must leave it either
    // released (nothing happened) or flagged for a person (something did).
    let record: { id: string } | null = null
    // True once something cannot be undone: a refund was sent or the order cancelled.
    let irreversible = false

    /** Undoes the claim when nothing irreversible has happened yet. Returns the error to throw. */
    const abort = async (message: string, code: string): Promise<MedusaError> => {
      if (record) {
        await service.deleteOrderCancellations(record.id)
      }
      await releaseCancelling(pg, orderId)
      return new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message, code)
    }

    let refundStatus: CancellationOutcome["refund_status"] | "pending" =
      planned.method === "none" ? "not_needed" : "pending"
    let refundError: string | null = null
    let refundId: string | null = null
    let walletTransactionId: string | null = null
    let walletExpiresAt: string | null = null
    let needsAttention = false

    try {
      const [existing] = await service.listOrderCancellations({ order_id: orderId }, { take: 1 })
      if (existing) {
        await releaseCancelling(pg, orderId)
        blocked("already_cancelled")
      }

      const created = await service.createOrderCancellations({
        order_id: orderId,
        requested_by: "customer",
        customer_id: input.customer_id,
        reason: input.reason,
        note: input.note ?? null,
        refund_method: planned.method,
        paid_online: planned.plan.paid_online,
        wallet_used: planned.plan.wallet_used,
        fee: planned.method === "original" ? planned.fee : 0,
        refund_amount: planned.refund_amount,
        status: "processing",
        refund_status: planned.method === "none" ? "not_needed" : "pending",
        cancelled_after_minutes: Math.max(0, Math.round((Date.now() - Date.parse(context.placed_at)) / 60000)),
      })
      record = created
      const cancellation = created

      if (planned.method === "original") {
        // 2a. Send the refund first; only then cancel.
        const refund = await getRefundGateway().refund({
          order_id: orderId,
          razorpay_payment_id: context.razorpay_payment_id,
          razorpay_order_id: context.razorpay_order_id,
          amount: planned.refund_amount,
          fee: planned.fee,
          cancellation_id: cancellation.id,
          since_ms: startedAt,
        })

        if (!refund.ok) {
          if (refund.may_have_moved_money) {
            // We cannot tell whether the money left. Leave everything as it is for a person.
            await service.updateOrderCancellations({
              id: cancellation.id,
              status: "needs_attention",
              refund_status: "unverified",
              refund_error: refund.error,
            })
            // The order stays held, so it never ships while a person checks.
            await noteCancellationProblem(pg, orderId, `Refund outcome unknown: ${refund.error}`)
            await postToStorefront(
              "/api/ops/notify",
              { type: "cancellation_stalled", order_id: orderId, detail: `Refund outcome unknown: ${refund.error}` },
              logger
            )
            throw new MedusaError(
              MedusaError.Types.UNEXPECTED_STATE,
              "We could not confirm your refund. Our team has been told and will sort it out. Please contact support.",
              "refund_unconfirmed"
            )
          }
          logger.error(`[cancel] refund failed for ${orderId}: ${refund.error}`)
          throw await abort(
            "We could not start your refund, so your order has not been cancelled. Please try again, or choose the wallet.",
            "refund_failed"
          )
        }

        irreversible = true
        refundId = refund.refund_id
        refundStatus = refund.verified ? "initiated" : "unverified"
        if (!refund.verified) {
          needsAttention = true
          refundError = "The refund was sent but Razorpay could not confirm it. Check the payment in Razorpay."
        }
        await service.updateOrderCancellations({
          id: cancellation.id,
          refund_status: refundStatus,
          razorpay_refund_id: refundId,
          refund_error: refundError,
        })
      }

      // The order itself.
      const cancelled = await cancelOrderRecords(container, orderId)
      if (!cancelled.ok) {
        logger.error(`[cancel] could not cancel order ${orderId}: ${cancelled.error}`)
        if (planned.method === "original") {
          // The refund already left, so this cannot be undone: flag it loudly.
          await service.updateOrderCancellations({
            id: cancellation.id,
            status: "needs_attention",
            refund_error: `The refund was sent but the order could not be cancelled: ${cancelled.error}`,
          })
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            "Your refund was sent but we could not finish cancelling the order. Our team has been told. Please contact support.",
            "cancel_incomplete"
          )
        }
        throw await abort("We could not cancel your order. Please try again.", "cancel_failed")
      }

      irreversible = true

      // 2b. Wallet refund, after the order is cancelled. Retryable if it fails.
      if (planned.method === "wallet") {
        const { result, errors } = await creditWalletForCancellationWorkflow(container).run({
          input: { order_id: orderId, customer_id: input.customer_id, amount: planned.refund_amount },
          throwOnError: false,
        })
        if (errors.length > 0 || !result) {
          refundStatus = "failed"
          refundError = errors[0]?.error?.message ?? "The wallet could not be credited"
          needsAttention = true
          logger.error(`[cancel] wallet credit failed for ${orderId}: ${refundError}`)
        } else {
          refundStatus = "credited"
          walletTransactionId = result.transaction_id
          walletExpiresAt = result.expires_at ? new Date(result.expires_at).toISOString() : null
        }
      }

      // 3. Close both records.
      await markCancelled(pg, orderId, ["cancelling", "placed", "dispatch_failed"])
      await service.updateOrderCancellations({
        id: cancellation.id,
        status: needsAttention ? "needs_attention" : "completed",
        refund_status: refundStatus,
        refund_error: refundError,
        wallet_transaction_id: walletTransactionId,
        completed_at: new Date(),
      })
    } catch (error) {
      // Errors raised above are already customer-ready.
      if (error instanceof MedusaError) {
        throw error
      }

      logger.error(`[cancel] unexpected error cancelling ${orderId}: ${(error as Error).message}`)
      if (!irreversible) {
        // Nothing moved: put the order back as it was, so it can still be cancelled or shipped.
        throw await abort("We could not cancel your order. Please try again.", "cancel_failed")
      }

      // Something already happened (a refund was sent, or the order was cancelled): a person must finish it.
      if (record) {
        await service.updateOrderCancellations({
          id: record.id,
          status: "needs_attention",
          refund_error: `Unexpected error: ${(error as Error).message}`.slice(0, 400),
        })
      }
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Something went wrong while cancelling your order. Our team has been told. Please contact support.",
        "cancel_incomplete"
      )
    }

    const outcome: CancellationOutcome = {
      cancellation_id: record!.id,
      order_id: orderId,
      refund_method: planned.method,
      paid_online: planned.plan.paid_online,
      wallet_used: planned.plan.wallet_used,
      fee: planned.method === "original" ? planned.fee : 0,
      refund_amount: planned.refund_amount,
      // Every path above sets a final status; "pending" can only mean a refund that never happened.
      refund_status: refundStatus === "pending" ? "failed" : refundStatus,
      status: needsAttention ? "needs_attention" : "completed",
      refund_error: refundError,
      wallet_expires_at: walletExpiresAt,
    }
    return new StepResponse(outcome)
  }
)
