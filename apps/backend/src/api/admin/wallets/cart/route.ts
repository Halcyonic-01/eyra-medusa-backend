import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyWalletToCartWorkflow } from "../../../../workflows/apply-wallet-to-cart"
import type { ApplyWalletToCartBody } from "../validation"

/**
 * POST /admin/wallets/cart
 *
 * Puts the customer's wallet credit on a cart. Called by the storefront
 * server, which has already identified the signed-in customer.
 */
export async function POST(
  req: MedusaRequest<ApplyWalletToCartBody>,
  res: MedusaResponse
) {
  const { result } = await applyWalletToCartWorkflow(req.scope).run({
    input: req.validatedBody,
  })

  return res.json(result)
}
