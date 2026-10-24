import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadCartSummary } from "../../../../../utils/cart-summary"

/**
 * GET /store/carts/:id/summary
 *
 * The cart as the storefront shows it: each line at the price Medusa charges, and
 * the items subtotal, discount, shipping charge and total worked out here. Read
 * only. The storefront reads it after every cart change instead of adding up
 * prices itself.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const cart = await loadCartSummary(req.scope, req.params.id)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ cart })
}
