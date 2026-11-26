import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { cartPaymentStanding } from "../../../../../modules/payment-snapshot/payment-standing"

/**
 * GET /store/carts/:id/payment-status
 *
 * Where the cart's online payment stands (ordered, paid, in progress, unknown,
 * none), whether a new payment may be opened and with which providers, and any
 * refunds owed or made. Read only; asked of the providers each time, and an
 * answer that cannot be checked never allows paying.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const standing = await cartPaymentStanding(req.scope, req.params.id)
  if (!standing) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  res.setHeader("Cache-Control", "no-store")
  return res.json({ payment: standing })
}
