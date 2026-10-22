import { createHash } from "node:crypto"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { CREDIT_NOTE_MODULE } from "../../modules/credit-note"
import { storeCreditNotePdf } from "../../modules/credit-note/storage"
import type CreditNoteModuleService from "../../modules/credit-note/service"
import { MAX_PDF_ATTEMPTS, retryDelayMinutes } from "../../utils/invoice-pdf-state"
import { callStorefront } from "../../utils/storefront"

export type CreditNotePdfOutcome =
  | { status: "stored"; key: string }
  | { status: "exists"; key: string }
  | { status: "failed"; code: string; message: string; attempts: number; gave_up: boolean }

/**
 * Draws a saved credit note as a PDF and keeps it. The storefront draws it from
 * the stored document (nothing is recalculated), the file is stored once, and a
 * repeat run finds it and does nothing. A failure never undoes the note: it is
 * recorded with a retry time, and the job tries again.
 */
export const renderStoreCreditNotePdfStep = createStep(
  "render-store-credit-note-pdf",
  async (input: { credit_note_id: string }, { container }) => {
    const service: CreditNoteModuleService = container.resolve(CREDIT_NOTE_MODULE)
    const note = await service.retrieveCreditNote(input.credit_note_id)
    if (note.pdf_key) {
      return new StepResponse<CreditNotePdfOutcome>({ status: "exists", key: note.pdf_key })
    }

    const fail = async (code: string, message: string): Promise<CreditNotePdfOutcome> => {
      const attempts = (note.pdf_attempts ?? 0) + 1
      await service.updateCreditNotes({
        id: note.id,
        pdf_attempts: attempts,
        pdf_retry_at: new Date(Date.now() + retryDelayMinutes(attempts) * 60_000),
        pdf_error: `${code}: ${message}`.slice(0, 300),
      })
      return { status: "failed", code, message, attempts, gave_up: attempts >= MAX_PDF_ATTEMPTS }
    }

    const reply = await callStorefront(
      "/api/credit-notes/render",
      { credit_note: note.payload as Record<string, unknown> },
      { timeoutMs: 30000 }
    )
    if (reply.kind !== "answered") return new StepResponse(await fail(reply.kind, reply.message))
    const body = reply.body ?? {}
    if (reply.status !== 200) {
      return new StepResponse(
        await fail(String(body.error ?? `storefront_${reply.status}`), String(body.message ?? `The storefront answered ${reply.status}`))
      )
    }

    const base64 = typeof body.pdf_base64 === "string" ? body.pdf_base64 : ""
    const bytes = Buffer.from(base64, "base64")
    if (bytes.length < 100 || bytes.subarray(0, 5).toString() !== "%PDF-") {
      return new StepResponse(await fail("not_a_pdf", "The storefront did not send a PDF"))
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (typeof body.sha256 === "string" && body.sha256 !== sha256) {
      return new StepResponse(await fail("corrupt", "The PDF was damaged on the way"))
    }
    if (body.credit_note_number !== note.credit_note_number) {
      return new StepResponse(await fail("number_mismatch", "The PDF is for a different credit note number"))
    }

    const stored = await storeCreditNotePdf(container, { number: note.credit_note_number, fy: note.fy, bytes })
    await service.updateCreditNotes({
      id: note.id,
      pdf_key: stored.key,
      pdf_sha256: sha256,
      pdf_attempts: 0,
      pdf_retry_at: null,
      pdf_error: null,
    })
    return new StepResponse<CreditNotePdfOutcome>({ status: "stored", key: stored.key })
  }
)
