import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { removeWalletFromCartWorkflow } from "../../../../../workflows/remove-wallet-from-cart"

/**
 * DELETE /admin/wallets/cart/:id
 *
 * Takes wallet credit off a cart, so the customer pays the full total.
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const { result } = await removeWalletFromCartWorkflow(req.scope).run({
    input: { cart_id: req.params.id },
  })

  return res.json(result)
}
