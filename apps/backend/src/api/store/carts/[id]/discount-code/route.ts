import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { applyDiscountCodeWorkflow } from "../../../../../workflows/apply-discount-code"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import type { DiscountCodeBody } from "../../validation"

/**
 * POST /store/carts/:id/discount-code   { code: string | null }
 *
 * Puts one discount code on the cart, replacing any other, or removes the code
 * when `code` is null. A code that does not fit the order is refused with a
 * plain reason. Returns the cart as the storefront shows it.
 */
export async function POST(req: MedusaRequest<DiscountCodeBody>, res: MedusaResponse) {
  const cartId = req.params.id

  await applyDiscountCodeWorkflow(req.scope).run({
    input: { cart_id: cartId, code: req.validatedBody.code },
  })

  const cart = await loadCartSummary(req.scope, cartId)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ cart })
}
