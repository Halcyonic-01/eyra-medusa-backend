import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { setWhatsappConsentWorkflow } from "../../../../../workflows/set-whatsapp-consent"
import type { WhatsappConsentBody } from "../../../../review-validation"

/** POST /store/carts/:id/whatsapp-consent  { opt_in }  The checkout's WhatsApp checkbox. */
export async function POST(req: MedusaRequest<WhatsappConsentBody>, res: MedusaResponse) {
  const { result } = await setWhatsappConsentWorkflow(req.scope).run({
    input: { cart_id: req.params.id, opt_in: req.validatedBody.opt_in },
  })
  return res.json({ whatsapp_opt_in: result.opt_in })
}
