import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { PAYMENT_SNAPSHOT_MODULE } from "../../modules/payment-snapshot"
import { checkPaidSnapshot, loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { RazorpayUnavailableError } from "../../modules/payment-snapshot/razorpay-api"
import { RAZORPAY_PROVIDER_ID, toPaise } from "../../modules/payment-snapshot/rules"
import type PaymentSnapshotModuleService from "../../modules/payment-snapshot/service"
import { stalePriceMessage } from "../../utils/stale-prices"
import { findStaleCartPricesWorkflow } from "../find-stale-cart-prices"

/**
 * Price part of the last check before a cart becomes an order.
 *
 * Every line must be at today's price, with one exception: the customer opened
 * a Razorpay payment at a snapshotted price and Razorpay confirms that exact
 * order was paid in full for that exact cart. Then the order is placed at the
 * price they paid, even if a sale ended while they were paying. Otherwise a
 * stale cart is refused rather than repriced, so the customer sees the new
 * total first. Cash on Delivery and wallet-only orders always need today's price.
 */
export async function validateCurrentPrices(cart: { id: string }, container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { result: stale } = await findStaleCartPricesWorkflow(container).run({
    input: { cart_id: cart.id },
  })

  if (stale.length) {
    let honoured = false
    try {
      honoured = (await checkPaidSnapshot(container, cart.id)).honoured
    } catch (error) {
      if (!(error instanceof RazorpayUnavailableError)) throw error
      // Unknown, so neither refuse for good nor accept: a 500 makes the caller retry.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "We could not confirm your payment with Razorpay just now. Please try again shortly."
      )
    }
    if (honoured) {
      logger.info(`[paid-price] cart ${cart.id} placed at the price paid at Razorpay (${stale.length} line(s) changed since)`)
      return
    }
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, stalePriceMessage(stale))
  }

  await validateSnapshotAmount(cart.id, container)
}

/** A Razorpay payment opened with a snapshot must still ask for the snapshotted amount. */
async function validateSnapshotAmount(cartId: string, container: MedusaContainer) {
  const state = await loadCartPaymentState(container, cartId)
  const session = state?.session
  if (!state || !session || session.provider_id !== RAZORPAY_PROVIDER_ID) return
  const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
  const [snapshot] = await service.listPaymentPriceSnapshots({ payment_session_id: session.id }, { take: 1 })
  if (!snapshot) return
  if (toPaise(session.amount) !== snapshot.amount_paise || toPaise(state.cart.total) !== snapshot.amount_paise) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "The amount due changed after the payment was opened. Please review your cart and try again."
    )
  }
}
