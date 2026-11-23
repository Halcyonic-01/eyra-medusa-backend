import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { paidAttempts, requestSettle } from "../../modules/payment-snapshot/late-payments"
import { RazorpayUnavailableError } from "../../modules/payment-snapshot/razorpay-api"

/**
 * Refuses to open a new Razorpay payment for a cart that is already an order or
 * already paid, on the current attempt or on one it replaced: a new session
 * would drop the paid one, leaving money taken and no order. A paid replaced
 * attempt is handed to the late-payment settle. Fails closed when Razorpay
 * cannot be asked.
 */
export const guardRazorpayCheckoutStep = createStep(
  "guard-razorpay-checkout",
  async (input: { cart_id: string }, { container }) => {
    const state = await loadCartPaymentState(container, input.cart_id)
    if (!state) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
    if (state.cart.completed_at) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This cart has already been ordered.")
    }
    let paid: { current: boolean; replaced: boolean }
    try {
      paid = await paidAttempts(container, input.cart_id, state.razorpaySessions)
    } catch (error) {
      if (!(error instanceof RazorpayUnavailableError)) throw error
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "We could not check your earlier payment just now. Please try again in a minute."
      )
    }
    if (paid.replaced) await requestSettle(container, input.cart_id)
    if (paid.current || paid.replaced) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart has already been paid for and your order is being confirmed. Please do not pay again."
      )
    }
    return new StepResponse(true)
  }
)
