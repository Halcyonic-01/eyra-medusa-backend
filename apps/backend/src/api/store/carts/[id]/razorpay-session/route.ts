import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import { startRazorpayCheckoutWorkflow } from "../../../../../workflows/start-razorpay-checkout"

/**
 * POST /store/carts/:id/razorpay-session
 *
 * Opens the Razorpay payment for a cart at today's prices and records what it
 * costs, so a sale ending while the customer pays cannot fail the order. Takes
 * no amounts from the caller. Returns the Razorpay order to open and its amount.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const cartId = req.params.id

  const { result } = await startRazorpayCheckoutWorkflow(req.scope).run({
    input: { cart_id: cartId },
  })

  const cart = await loadCartSummary(req.scope, cartId)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ ...result, cart })
}
