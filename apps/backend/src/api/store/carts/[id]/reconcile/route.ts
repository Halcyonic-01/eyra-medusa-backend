import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import { reconcileCartToteWorkflow } from "../../../../../workflows/reconcile-cart-tote"

/**
 * POST /store/carts/:id/reconcile
 *
 * Brings the cart's complimentary tote bag in line with its items (see the
 * workflow), then returns the cart as the storefront shows it. The storefront
 * calls it after every cart change. Prices are never taken from the caller.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const cartId = req.params.id

  const { result: tote_status } = await reconcileCartToteWorkflow(req.scope).run({
    input: { cart_id: cartId },
  })

  const cart = await loadCartSummary(req.scope, cartId)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ cart, tote_status })
}
