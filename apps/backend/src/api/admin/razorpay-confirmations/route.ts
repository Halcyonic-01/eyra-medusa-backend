import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { recordRazorpayConfirmationWorkflow } from "../../../workflows/record-razorpay-confirmation"
import type { RazorpayConfirmationBody } from "./validation"

/**
 * POST /admin/razorpay-confirmations   { cart_id, razorpay_order_id, razorpay_payment_id }
 *
 * Called by the storefront after verify or the webhook, even when the cart was
 * already completed: records the Razorpay ids on the order and returns its id.
 */
export async function POST(req: MedusaRequest<RazorpayConfirmationBody>, res: MedusaResponse) {
  const { result } = await recordRazorpayConfirmationWorkflow(req.scope).run({ input: req.validatedBody })
  return res.json(result)
}
