import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { setCartPaymentModeWorkflow } from "../../../../../workflows/set-cart-payment-mode"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import type { PaymentModeBody } from "../../validation"

/**
 * POST /store/carts/:id/payment-mode   { mode: "prepaid" | "cod" }
 *
 * Sets the shipping charge for how the order will be paid: free for prepaid,
 * the Cash on Delivery charge for COD. Switching mode replaces the charge, so
 * it can never be counted twice. Returns the cart as the storefront shows it.
 */
export async function POST(req: MedusaRequest<PaymentModeBody>, res: MedusaResponse) {
  const cartId = req.params.id

  await setCartPaymentModeWorkflow(req.scope).run({
    input: { cart_id: cartId, mode: req.validatedBody.mode },
  })

  const cart = await loadCartSummary(req.scope, cartId)
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }
  return res.json({ cart })
}
