import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MAX_PDF_ATTEMPTS, retryDelayMinutes } from "../../utils/invoice-pdf-state"
import type { InvoicePdfState } from "./load-invoice-pdf-state"
import type { RenderedPdf } from "./render-invoice-pdf"
import type { StoredFile } from "./store-invoice-pdf"

export type InvoicePdfOutcome =
  | { status: "stored"; key: string }
  | { status: "exists"; key: string }
  | { status: "skipped"; code: string; message: string }
  | { status: "failed"; code: string; message: string; attempts: number; gave_up: boolean }

type Input = {
  state: InvoicePdfState
  render: RenderedPdf
  /** Undefined when nothing was drawn and so nothing was stored. */
  file?: StoredFile
}

/**
 * Writes what happened onto the order: the stored file, or that an attempt
 * failed and when to try again. The file's record carries the invoice number it
 * was drawn for, so it can never be mistaken for another invoice's.
 */
export const recordInvoicePdfStep = createStep(
  "record-invoice-pdf",
  async (input: Input, { container }) => {
    const { state, render, file } = input
    const orders = container.resolve(Modules.ORDER)

    if (state.stored) {
      return new StepResponse<InvoicePdfOutcome>({ status: "exists", key: state.stored.key })
    }

    if (render.ok && file?.stored && file.key) {
      await orders.updateOrders(
        { id: state.order_id },
        {
          metadata: {
            invoice_pdf: {
              key: file.key,
              invoice_number: render.invoice_number,
              generated_at: new Date().toISOString(),
              sha256: render.sha256,
            },
            invoice_pdf_attempts: 0,
            invoice_pdf_retry_at: null,
            invoice_pdf_error: null,
          },
        }
      )
      return new StepResponse<InvoicePdfOutcome>({ status: "stored", key: file.key })
    }

    if (!render.ok && render.skipped) {
      return new StepResponse<InvoicePdfOutcome>({ status: "skipped", code: render.code, message: render.message })
    }

    const code = render.ok ? "store_failed" : render.code
    const message = render.ok ? "The PDF could not be saved" : render.message
    const [order] = (await orders.listOrders({ id: [state.order_id] }, { select: ["id", "metadata"] })) as {
      id: string
      metadata?: Record<string, unknown> | null
    }[]
    const attempts = (Number(order?.metadata?.invoice_pdf_attempts ?? 0) || 0) + 1
    await orders.updateOrders(
      { id: state.order_id },
      {
        metadata: {
          invoice_pdf_attempts: attempts,
          invoice_pdf_retry_at: new Date(Date.now() + retryDelayMinutes(attempts) * 60_000).toISOString(),
          invoice_pdf_error: `${code}: ${message}`.slice(0, 300),
        },
      }
    )
    return new StepResponse<InvoicePdfOutcome>({
      status: "failed",
      code,
      message,
      attempts,
      gave_up: attempts >= MAX_PDF_ATTEMPTS,
    })
  }
)
