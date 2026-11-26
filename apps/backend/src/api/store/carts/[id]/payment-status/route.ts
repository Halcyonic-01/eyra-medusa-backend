import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { cartPaymentStanding, type PaymentStanding } from "../../../../../modules/payment-snapshot/payment-standing"

/**
 * GET /store/carts/:id/payment-status
 *
 * Where the cart's online payment stands (ordered, paid, in progress, unknown,
 * none), whether a new payment may be opened and with which providers, and any
 * refunds owed or made. Read only; an answer that cannot be checked never
 * allows paying.
 *
 * Public, and each answer asks the providers, so answers are reused for a few
 * seconds per cart: repeated calls cannot use up the providers' API limits that
 * real checkouts depend on. Paying is still checked fresh when it is opened.
 */
const MAX_CACHED = 500
const recent = new Map<string, { at: number; standing: PaymentStanding }>()

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const cartId = req.params.id
  const cacheMs = Number(process.env.PAYMENT_STATUS_CACHE_MS ?? 5000)
  const now = Date.now()
  const hit = recent.get(cartId)
  let standing = hit && now - hit.at < cacheMs ? hit.standing : null
  if (!standing) {
    standing = await cartPaymentStanding(req.scope, cartId)
    if (!standing) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
    if (recent.size >= MAX_CACHED) recent.delete(recent.keys().next().value as string)
    recent.set(cartId, { at: now, standing })
  }
  res.setHeader("Cache-Control", "no-store")
  return res.json({ payment: standing })
}
