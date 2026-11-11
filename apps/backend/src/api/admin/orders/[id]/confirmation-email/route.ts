import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { confirmationEmailWorkflow } from "../../../../../workflows/confirmation-email"
import type { ConfirmationEmailBody } from "../../../razorpay-confirmations/validation"

/**
 * POST /admin/orders/:id/confirmation-email   { action: "claim" | "sent" | "release" }
 *
 * The storefront claims before sending the order confirmation, marks it sent
 * after, or releases the claim if sending failed. Only one claim wins.
 */
export async function POST(req: MedusaRequest<ConfirmationEmailBody>, res: MedusaResponse) {
  const { result } = await confirmationEmailWorkflow(req.scope).run({
    input: { order_id: req.params.id, action: req.validatedBody.action },
  })
  return res.json(result)
}
