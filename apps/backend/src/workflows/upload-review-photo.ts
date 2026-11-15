import { MedusaError } from "@medusajs/framework/utils"
import { createStep, createWorkflow, StepResponse, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { uploadFilesWorkflow } from "@medusajs/medusa/core-flows"
import { PRODUCT_REVIEW_MODULE } from "../modules/product-review"
import { checkPhoto, photoExtension } from "../modules/product-review/photos"
import type ProductReviewModuleService from "../modules/product-review/service"
import { photoAllowance, resolveReviewAccess, type Reviewer } from "./steps/review-submissions"

export type UploadReviewPhotoInput = { reviewer: Reviewer; content_base64: string }

const checkReviewPhotoStep = createStep("check-review-photo", async (input: UploadReviewPhotoInput, { container }) => {
  const access = await resolveReviewAccess(container, input.reviewer)
  if ((await photoAllowance(container, access.order.id)) <= 0) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "No more photos can be added to this order's reviews.")
  }
  const photo = checkPhoto(input.content_base64)
  if (!photo.ok) throw new MedusaError(MedusaError.Types.INVALID_DATA, photo.error)
  return new StepResponse({
    order_id: access.order.id,
    mime: photo.mime,
    size: photo.size,
    filename: `review-${access.order.id}-${Date.now()}.${photoExtension(photo.mime)}`,
  })
})

const recordReviewPhotoStep = createStep(
  "record-review-photo",
  async (input: { order_id: string; file_id: string; url: string; mime_type: string; size: number }, { container }) => {
    const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
    const photo = await service.createReviewImages({ ...input, status: "uploaded" })
    return new StepResponse({ id: photo.id, url: photo.url }, photo.id)
  },
  async (id, { container }) => {
    if (!id) return
    const service: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
    await service.deleteReviewImages(id)
  }
)

/**
 * Stores one review photo in Medusa's file storage for an order the uploader
 * may review. The bytes are checked to really be a JPEG, PNG or WebP, under the
 * size limit and the per-order count. The storefront has already resized it
 * and stripped its location and camera data.
 */
export const uploadReviewPhotoWorkflow = createWorkflow("upload-review-photo", function (input: UploadReviewPhotoInput) {
  const checked = checkReviewPhotoStep(input)
  const uploaded = uploadFilesWorkflow.runAsStep({
    input: transform({ checked, input }, (data) => ({
      files: [{ filename: data.checked.filename, mimeType: data.checked.mime, content: data.input.content_base64, access: "public" as const }],
    })),
  })
  const photo = recordReviewPhotoStep(
    transform({ checked, uploaded }, (data) => ({
      order_id: data.checked.order_id,
      file_id: data.uploaded[0].id,
      url: data.uploaded[0].url,
      mime_type: data.checked.mime,
      size: data.checked.size,
    }))
  )
  return new WorkflowResponse(photo)
})

