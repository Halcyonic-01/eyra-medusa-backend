import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { checkPaidSnapshot } from "../../modules/payment-snapshot/check"
import { RazorpayUnavailableError } from "../../modules/payment-snapshot/razorpay-api"

export type CheckPaidSnapshotInput = { cart_id: string; stale_count: number }

/**
 * Before repricing a stale cart: if the customer has already paid for it at the
 * snapshotted price, the prices are held so the paid payment can still become
 * an order. Razorpay is only asked when there is something stale to reprice.
 */
export const checkPaidSnapshotStep = createStep(
  "check-paid-snapshot",
  async (input: CheckPaidSnapshotInput, { container }) => {
    if (!input.stale_count) return new StepResponse({ hold_prices: false, reason: "nothing_stale" })
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    try {
      const verdict = await checkPaidSnapshot(container, input.cart_id)
      if (verdict.honoured) {
        logger.info(`[paid-price] cart ${input.cart_id} is paid at its snapshot price, not repricing`)
        return new StepResponse({ hold_prices: true, reason: "paid" })
      }
      return new StepResponse({ hold_prices: false, reason: verdict.reason })
    } catch (error) {
      if (!(error instanceof RazorpayUnavailableError)) throw error
      // Unknown is not unpaid: keep the cart as it is. Completion still needs proof of payment.
      logger.warn(`[paid-price] could not ask Razorpay about cart ${input.cart_id}, not repricing: ${error.message}`)
      return new StepResponse({ hold_prices: true, reason: "razorpay_unavailable" })
    }
  }
)
