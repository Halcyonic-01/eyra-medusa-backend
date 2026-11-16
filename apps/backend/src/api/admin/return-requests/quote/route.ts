import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { quoteReturnRequestWorkflow } from "../../../../workflows/quote-return-request"
import type { CreateReturnRequestBody } from "../validation"

/**
 * POST /admin/return-requests/quote
 *
 * What a return or exchange would cost or give back, with the same checks a
 * real request goes through, without saving anything. Called by the storefront
 * server on behalf of the signed-in customer, before they confirm.
 */
export async function POST(req: AuthenticatedMedusaRequest<CreateReturnRequestBody>, res: MedusaResponse) {
  const { result } = await quoteReturnRequestWorkflow(req.scope).run({ input: req.validatedBody })
  return res.json({ quote: result })
}
