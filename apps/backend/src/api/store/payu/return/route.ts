import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { confirmPayuReturn } from "../../../../modules/payu-payment/confirm-return"
import type { PayuResponse } from "../../../../modules/payu-payment/hash"

/**
 * POST /store/payu/return   { ...the fields PayU posted to surl/furl }
 *
 * The storefront forwards what PayU posted when the customer came back. The
 * fields must carry PayU's hash; the outcome is decided from PayU's own
 * records, then the cart is completed if it was paid. Safe to repeat.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = req.body
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid request: body must be an object")
  }
  const fields = Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([, value]) => typeof value === "string")
  ) as PayuResponse
  return res.json(await confirmPayuReturn(req.scope, fields))
}
