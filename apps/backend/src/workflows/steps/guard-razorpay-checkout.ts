import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { paidAttempts, requestSettle } from "../../modules/payment-snapshot/late-payments"
import { GatewayUnavailableError, RAZORPAY_PROVIDER_ID, getGateway } from "../../modules/payment-snapshot/gateways"

/**
 * Refuses to open a new online payment (Razorpay by default, or the given
 * provider) for a cart that is already an order or already paid, on the
 * current attempt or on one it replaced, with any provider: a new session
 * would drop the paid one, leaving money taken and no order. A paid replaced
 * attempt is handed to the late-payment settle.
 *
 * It also never lets checkout move to another provider while a payment with
 * a different provider is still in progress, or while any provider cannot be
 * asked (fails closed): the customer waits for that payment to settle.
 * Retrying with the same provider is unchanged.
 */
export const guardRazorpayCheckoutStep = createStep(
  "guard-razorpay-checkout",
  async (input: { cart_id: string; provider_id?: string }, { container }) => {
    const opening = input.provider_id ?? RAZORPAY_PROVIDER_ID
    const state = await loadCartPaymentState(container, input.cart_id)
    if (!state) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
    if (state.cart.completed_at) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This cart has already been ordered.")
    }
    let paid: { current: boolean; replaced: boolean; pending_providers: string[] }
    try {
      paid = await paidAttempts(container, input.cart_id, state.prepaidSessions)
    } catch (error) {
      if (!(error instanceof GatewayUnavailableError)) throw error
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "We could not check your earlier payment just now. Please try again in a minute."
      )
    }
    if (paid.replaced) await requestSettle(container, input.cart_id)
    const elsewhere = paid.pending_providers.filter((id) => id !== opening)
    if (elsewhere.length && !paid.current && !paid.replaced) {
      const name = getGateway(elsewhere[0])?.name ?? "another payment method"
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Your payment with ${name} is still being confirmed. Please wait a few minutes before paying another way.`
      )
    }
    if (paid.current || paid.replaced) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart has already been paid for and your order is being confirmed. Please do not pay again."
      )
    }
    return new StepResponse(true)
  }
)
