import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { findReconcileCandidates } from "../modules/order-dispatch/payment-reconcile"
import { RazorpayUnavailableError } from "../modules/payment-snapshot/razorpay-api"
import { postToStorefront } from "../utils/storefront"
import { repairOrderPaymentWorkflow } from "../workflows/repair-order-payment"

/**
 * Every five minutes: find orders an interrupted checkout left without a
 * payment record and record it once the payment is proven (Razorpay confirms
 * it, or it is Cash on Delivery); tell the team about any that cannot be
 * proven, and about orders that never got linked to their checkout. Neither
 * kind is ever shipped (see the dispatch claim), and nothing here refunds.
 */
export default async function reconcileOrderPayments(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orders = container.resolve(Modules.ORDER)
  const { paymentless, orphans } = await findReconcileCandidates(container)

  for (const candidate of paymentless) {
    try {
      const { result, errors } = await repairOrderPaymentWorkflow(container).run({
        input: { order_id: candidate.order_id },
        throwOnError: false,
      })
      if (errors?.length || !result) {
        const error = errors?.[0]?.error as Error | undefined
        const why = error instanceof RazorpayUnavailableError ? "Razorpay unreachable, will retry" : error?.message ?? "no result"
        logger.error(`[payment-reconcile] order ${candidate.order_id} not repaired this run: ${why}`)
        continue
      }
      if (result.action === "authorize") {
        logger.warn(`[payment-reconcile] recorded the missing payment for order ${candidate.order_id}`)
        continue
      }
      if (result.action === "unpaid" && !candidate.alerted) {
        const sent = await postToStorefront(
          "/api/ops/notify",
          { type: "order_payment_unconfirmed", order_id: candidate.order_id, order_ref: `EYRA-${candidate.display_id}`, reason: result.reason },
          logger
        )
        if (sent === "sent") {
          await orders.updateOrders({ id: candidate.order_id }, { metadata: { payment_unconfirmed_alerted: true } })
        }
      }
    } catch (error) {
      logger.error(`[payment-reconcile] order ${candidate.order_id}: ${(error as Error).message}`)
    }
  }

  for (const orphan of orphans) {
    logger.error(`[payment-reconcile] order ${orphan.order_id} is not linked to any checkout; it will not be shipped`)
    const sent = await postToStorefront(
      "/api/ops/notify",
      { type: "order_orphaned", order_id: orphan.order_id, order_ref: `EYRA-${orphan.display_id}` },
      logger
    )
    if (sent === "sent") {
      await orders.updateOrders({ id: orphan.order_id }, { metadata: { orphan_alerted: true } })
    }
  }
}

export const config = {
  name: "reconcile-order-payments",
  schedule: "*/5 * * * *",
}
