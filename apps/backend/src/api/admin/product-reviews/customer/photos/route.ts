import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { uploadReviewPhotoWorkflow } from "../../../../../workflows/upload-review-photo"
import type { CustomerPhotoBody } from "../../../../review-validation"

/** POST /admin/product-reviews/customer/photos  { customer_id, order_id, content_base64 }  A photo for a signed-in customer's review. */
export async function POST(req: AuthenticatedMedusaRequest<CustomerPhotoBody>, res: MedusaResponse) {
  const { customer_id, order_id, content_base64 } = req.validatedBody
  const { result } = await uploadReviewPhotoWorkflow(req.scope).run({
    input: { reviewer: { source: "account", customer_id, order_id }, content_base64 },
  })
  return res.status(201).json({ photo: result })
}
