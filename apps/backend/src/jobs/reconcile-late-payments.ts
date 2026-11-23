import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findLatePaymentCarts } from "../modules/payment-snapshot/late-candidates"
import { settleLatePayments } from "../modules/payment-snapshot/late-payments"
import { RazorpayUnavailableError } from "../modules/payment-snapshot/razorpay-api"

/**
 * Every five minutes: settle carts with Razorpay attempts that a newer attempt
 * (or a switch to Cash on Delivery) replaced, in case one was paid and no
 * webhook or completion noticed; finish refunds that are owed and recoveries
 * that are not an order yet. Everything it does is safe to repeat.
 */
export default async function reconcileLatePayments(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  for (const cartId of await findLatePaymentCarts(container)) {
    try {
      const result = await settleLatePayments(container, cartId, { complete: true, recheckAfterMinutes: 4 })
      if (result.recovered || result.refunded || result.refunding || result.review) {
        logger.warn(`[late-payment] job settled cart ${cartId}: ${JSON.stringify(result)}`)
      }
    } catch (error) {
      const why = error instanceof RazorpayUnavailableError ? "Razorpay unreachable, will retry" : (error as Error).message
      logger.error(`[late-payment] job could not settle cart ${cartId}: ${why}`)
    }
  }
}

export const config = {
  name: "reconcile-late-payments",
  schedule: "*/5 * * * *",
}
