import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { RenderedPdf } from "./render-invoice-pdf"

export type StoredFile = { stored: boolean; key: string | null }

/**
 * Saves the PDF in the file service as a private file: on S3 that is a private
 * object with no public address. If a later step fails, the file is removed so
 * a retry does not leave a stray copy behind.
 */
export const storeInvoicePdfStep = createStep(
  "store-invoice-pdf",
  async (input: { render: RenderedPdf }, { container }) => {
    if (!input.render.ok) {
      return new StepResponse<StoredFile, string | null>({ stored: false, key: null }, null)
    }
    const files = container.resolve(Modules.FILE)
    const [file] = await files.createFiles([
      {
        filename: input.render.filename,
        mimeType: "application/pdf",
        content: input.render.pdf_base64,
        access: "private",
      },
    ])
    return new StepResponse<StoredFile, string | null>({ stored: true, key: file.id }, file.id)
  },
  async (key, { container }) => {
    if (!key) return
    await container.resolve(Modules.FILE).deleteFiles([key])
  }
)
