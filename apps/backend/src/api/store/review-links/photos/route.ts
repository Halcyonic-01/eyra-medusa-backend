import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { uploadReviewPhotoWorkflow } from "../../../../workflows/upload-review-photo"
import type { LinkPhotoBody } from "../../../review-validation"

/** POST /store/review-links/photos  { token, content_base64 }  Adds one photo for a review sent with the link. */
export async function POST(req: MedusaRequest<LinkPhotoBody>, res: MedusaResponse) {
  const { result } = await uploadReviewPhotoWorkflow(req.scope).run({
    input: { reviewer: { source: "link", token: req.validatedBody.token }, content_base64: req.validatedBody.content_base64 },
  })
  return res.status(201).json({ photo: result })
}
