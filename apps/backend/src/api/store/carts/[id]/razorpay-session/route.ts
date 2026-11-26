import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { checkoutLockKey } from "../../../../../modules/payment-snapshot/gateways/ids"
import { resumableRazorpayAttempt } from "../../../../../modules/payment-snapshot/payment-standing"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import { startRazorpayCheckoutWorkflow } from "../../../../../workflows/start-razorpay-checkout"

/**
 * POST /store/carts/:id/razorpay-session
 *
 * Opens the Razorpay payment for a cart at today's prices and records what it
 * costs, so a sale ending while the customer pays cannot fail the order. Takes
 * no amounts from the caller. Returns the Razorpay order to open and its amount.
 * While a try on the current order is still in limbo at Razorpay and the cart is
 * unchanged, the same order is returned (resumed: true) instead of a new one.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const cartId = req.params.id

  // A try on the current Razorpay order still in limbo, cart unchanged: continue that
  // same order (paid once at most) rather than open a second payment beside it.
  const resumed = await req.scope
    .resolve(Modules.LOCKING)
    .execute(checkoutLockKey(cartId), () => resumableRazorpayAttempt(req.scope, cartId), { timeout: 30 })
  const result = resumed
    ? { ...resumed, resumed: true }
    : (await startRazorpayCheckoutWorkflow(req.scope).run({ input: { cart_id: cartId } })).result

  const cart = await loadCartSummary(req.scope, cartId)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ ...result, cart })
}
