import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { paidAttempts, requestSettle, type PaidAttempts } from "../../modules/payment-snapshot/late-payments"
import { PENDING_HOLD_MINUTES, pendingRule } from "../../modules/payment-snapshot/payment-standing"
import { GatewayUnavailableError, RAZORPAY_PROVIDER_ID, getGateway } from "../../modules/payment-snapshot/gateways"

/**
 * Refuses to open a new online payment (Razorpay by default, or the given
 * provider) for a cart that is already an order or already paid, on the
 * current attempt or on one it replaced, with any provider: a new session
 * would drop the paid one, leaving money taken and no order. A paid replaced
 * attempt is handed to the late-payment settle.
 *
 * It also never opens a payment while one is still in progress at a provider,
 * the same provider included, for PENDING_HOLD_MINUTES: the customer is never
 * asked to pay again while their payment may still go through. After that a
 * retry with the same provider is allowed (a late success is refunded), but
 * switching provider still waits until the payment settles. Nothing is opened
 * while a provider cannot be asked (fails closed).
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
    let paid: PaidAttempts
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
    if (paid.pending.length && !paid.current && !paid.replaced) {
      const rule = pendingRule(paid.pending, new Date())
      const name = getGateway(paid.pending[0].provider_id)?.name ?? "another payment method"
      if (!rule.can_pay) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Your payment with ${name} is still being confirmed. Please don't pay again: it can take up to ${PENDING_HOLD_MINUTES} minutes.`
        )
      }
      if (!rule.allowed.includes(opening)) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Your payment with ${name} is still being confirmed. Please wait for it before paying another way.`
        )
      }
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
