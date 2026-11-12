import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * Records the payment for a repaired order by authorizing its session, which
 * Medusa does idempotently (an authorized session returns its payment). On
 * purpose there is no undo: Medusa's own authorize step cancels, and with
 * Razorpay can refund, the payment if anything after it fails, and a paid
 * order must never be refunded because its repair hit a problem.
 */
export const authorizeRecoveredPaymentStep = createStep(
  "authorize-recovered-payment",
  async (input: { session_id: string }, { container }) => {
    const payment = await container.resolve(Modules.PAYMENT).authorizePaymentSession(input.session_id, {})
    return new StepResponse({ payment_id: payment.id })
  }
)
