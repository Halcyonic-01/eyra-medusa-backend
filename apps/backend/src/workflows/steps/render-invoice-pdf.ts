import { createHash } from "node:crypto"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { callStorefront } from "../../utils/storefront"
import type { InvoicePdfState } from "./load-invoice-pdf-state"

export type RenderedPdf =
  | { ok: true; filename: string; invoice_number: string; sha256: string; pdf_base64: string }
  | { ok: false; skipped: boolean; code: string; message: string }

/**
 * Asks the storefront to draw the PDF for an order that has a tax invoice
 * number. The storefront reads the order itself and uses the number it already
 * has, so this can never issue a number. Nothing is drawn when the invoice is
 * already stored or the order has no number yet.
 */
export const renderInvoicePdfStep = createStep(
  "render-invoice-pdf",
  async (input: { state: InvoicePdfState }, { container: _container }) => {
    const { state } = input
    if (state.stored) {
      return new StepResponse<RenderedPdf>({ ok: false, skipped: true, code: "already_stored", message: "Already stored" })
    }
    if (!state.invoice_number) {
      return new StepResponse<RenderedPdf>({
        ok: false,
        skipped: true,
        code: "no_invoice",
        message: "The order has no tax invoice number yet",
      })
    }

    const reply = await callStorefront("/api/invoices/render", { order_id: state.order_id }, { timeoutMs: 30000 })

    if (reply.kind === "skipped") {
      return new StepResponse<RenderedPdf>({ ok: false, skipped: false, code: "storefront_not_configured", message: reply.message })
    }
    if (reply.kind === "unreachable") {
      return new StepResponse<RenderedPdf>({ ok: false, skipped: false, code: "storefront_unreachable", message: reply.message })
    }

    const body = reply.body ?? {}
    if (reply.status !== 200) {
      return new StepResponse<RenderedPdf>({
        ok: false,
        skipped: false,
        code: String(body.error ?? `storefront_${reply.status}`),
        message: String(body.message ?? `The storefront answered ${reply.status}`),
      })
    }

    const base64 = typeof body.pdf_base64 === "string" ? body.pdf_base64 : ""
    const bytes = Buffer.from(base64, "base64")
    if (bytes.length < 100 || bytes.subarray(0, 5).toString() !== "%PDF-") {
      return new StepResponse<RenderedPdf>({ ok: false, skipped: false, code: "not_a_pdf", message: "The storefront did not send a PDF" })
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (typeof body.sha256 === "string" && body.sha256 !== sha256) {
      return new StepResponse<RenderedPdf>({ ok: false, skipped: false, code: "corrupt", message: "The PDF was damaged on the way" })
    }
    if (body.invoice_number !== state.invoice_number) {
      return new StepResponse<RenderedPdf>({
        ok: false,
        skipped: false,
        code: "number_mismatch",
        message: "The PDF is for a different invoice number than the order's",
      })
    }
    if (body.unverified === true) {
      // A draft is never kept: it carries a "not a valid tax invoice" notice.
      return new StepResponse<RenderedPdf>({ ok: false, skipped: false, code: "invoice_not_valid", message: "The invoice is not valid yet" })
    }

    return new StepResponse<RenderedPdf>({
      ok: true,
      filename: String(body.filename ?? "invoice.pdf"),
      invoice_number: state.invoice_number,
      sha256,
      pdf_base64: base64,
    })
  }
)
