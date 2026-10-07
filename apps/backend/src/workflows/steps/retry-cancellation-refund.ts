import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCancellationContext } from "../../modules/order-dispatch/cancellation-context"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import { getRefundGateway } from "../../modules/order-dispatch/refund-gateway"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { markCancelled, type Pg } from "../../modules/order-dispatch/transitions"
import { toNumber } from "../../modules/wallet/utils"
import { cancelOrderRecordsWorkflow } from "../cancel-order-records"
import { creditWalletForCancellationWorkflow } from "../credit-wallet-for-cancellation"
import { postToStorefront } from "../../utils/storefront"

type Input = {
  order_id: string
}

export type RetryRefundResult = {
  order_id: string
  refund_status: string
  status: string
  refund_error: string | null
}

/**
 * Finishes a cancellation whose refund did not go through: credits the wallet
 * again (safe, it only ever credits once), or sends the bank refund through the
 * same gateway as the first attempt, which returns a refund already made for
 * this cancellation instead of sending a second. Also finishes cancelling the
 * order if that was the part that failed. For staff, from the admin.
 */
export const retryCancellationRefundStep = createStep(
  "retry-cancellation-refund",
  async (input: Input, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)

    const [record] = await service.listOrderCancellations({ order_id: input.order_id }, { take: 1 })
    if (!record) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "This order has no cancellation to retry", "no_cancellation")
    }
    if (record.refund_status !== "failed" && record.refund_status !== "unverified" && record.status !== "needs_attention") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "There is nothing to retry for this order", "nothing_to_retry")
    }

    const context = await loadCancellationContext(container, input.order_id)
    if (!context) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found", "order_not_found")
    }

    type RefundStatus = "not_needed" | "pending" | "initiated" | "credited" | "failed" | "unverified"
    let refundStatus: RefundStatus = record.refund_status
    let refundError: string | null = record.refund_error ?? null
    let refundId: string | null = record.razorpay_refund_id ?? null
    let walletTransactionId: string | null = record.wallet_transaction_id ?? null
    const refundAmount = toNumber(record.refund_amount)

    // The order itself first, if that is what failed.
    if (context.order_status !== "canceled") {
      const { errors } = await cancelOrderRecordsWorkflow(container).run({
        input: { order_id: input.order_id },
        throwOnError: false,
      })
      if (errors.length > 0) {
        refundError = `The order could not be cancelled: ${errors[0].error?.message ?? "unknown error"}`
        await service.updateOrderCancellations({ id: record.id, refund_error: refundError })
        const result: RetryRefundResult = {
          order_id: input.order_id,
          refund_status: refundStatus,
          status: "needs_attention",
          refund_error: refundError,
        }
        return new StepResponse(result)
      }
    }

    if (record.refund_method === "wallet" && record.refund_status !== "credited") {
      const { result, errors } = await creditWalletForCancellationWorkflow(container).run({
        input: {
          order_id: input.order_id,
          customer_id: String(record.customer_id),
          amount: refundAmount,
        },
        throwOnError: false,
      })
      if (errors.length > 0 || !result) {
        refundStatus = "failed"
        refundError = errors[0]?.error?.message ?? "The wallet could not be credited"
      } else {
        refundStatus = "credited"
        refundError = null
        walletTransactionId = result.transaction_id
      }
    }

    if (record.refund_method === "original" && record.refund_status !== "initiated") {
      const refund = await getRefundGateway().refund({
        order_id: input.order_id,
        razorpay_payment_id: context.razorpay_payment_id,
        razorpay_order_id: context.razorpay_order_id,
        amount: refundAmount,
        fee: toNumber(record.fee),
        cancellation_id: record.id,
        since_ms: new Date(record.created_at).getTime(),
      })
      if (refund.ok) {
        refundStatus = refund.verified ? "initiated" : "unverified"
        refundId = refund.refund_id
        refundError = refund.verified ? null : "The refund was sent but could not be confirmed"
      } else {
        // Unclear stays unverified, so the next retry looks before it sends.
        refundStatus = refund.may_have_moved_money ? "unverified" : "failed"
        refundError = refund.error
      }
    }

    const resolved = refundStatus === "credited" || refundStatus === "initiated"
    if (resolved) {
      await markCancelled(pg, input.order_id, ["cancelling", "placed", "dispatch_failed"])
    }
    await service.updateOrderCancellations({
      id: record.id,
      status: resolved ? "completed" : "needs_attention",
      refund_status: refundStatus,
      refund_error: refundError,
      razorpay_refund_id: refundId,
      wallet_transaction_id: walletTransactionId,
      completed_at: resolved ? new Date() : null,
    })

    if (resolved && context.email) {
      await postToStorefront(
        "/api/wallet/notify",
        {
          type: "order_cancelled",
          email: context.email,
          order_number: context.display_id,
          method: record.refund_method,
          paid_online: toNumber(record.paid_online),
          wallet_used: toNumber(record.wallet_used),
          fee: toNumber(record.fee),
          refund_amount: refundAmount,
          refund_status: refundStatus,
          eta: process.env.BANK_REFUND_ETA?.trim() || "5 to 7 working days",
          wallet_expires_at: null,
          valid_months: 6,
        },
        logger
      )
    }

    const result: RetryRefundResult = {
      order_id: input.order_id,
      refund_status: refundStatus,
      status: resolved ? "completed" : "needs_attention",
      refund_error: refundError,
    }
    return new StepResponse(result)
  }
)
