import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { closeExchangePayment } from "../../modules/return-request/exchange-payment"

/**
 * After an exchange is declined: its unpaid payment link is cancelled, and a
 * price difference already paid is refunded. Never fails the decline.
 */
export const closeExchangePaymentStep = createStep(
  "close-exchange-payment",
  async (input: { request_id: string }, { container }) => {
    await closeExchangePayment(container, input.request_id)
    return new StepResponse({ request_id: input.request_id })
  }
)
