import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { IssueCreditNoteInput } from "../modules/credit-note/issue"
import { generateCreditNotePdfWorkflow } from "./generate-credit-note-pdf"
import { issueCreditNoteStep } from "./steps/issue-credit-note"

/**
 * Issues a statutory credit note for a return, exchange, or a cancellation after
 * dispatch, then draws and stores its PDF. The note is saved before the PDF is
 * attempted, and a PDF that cannot be drawn now is retried by a job, so the
 * note and its number never wait on the storefront.
 */
export const issueCreditNoteWorkflow = createWorkflow(
  "issue-credit-note",
  function (input: IssueCreditNoteInput) {
    const issued = issueCreditNoteStep(input)

    const pdf = generateCreditNotePdfWorkflow.runAsStep({
      input: transform({ issued }, (data) => ({ credit_note_id: data.issued.credit_note_id })),
    })

    return new WorkflowResponse(transform({ issued, pdf }, (data) => ({ ...data.issued, pdf: data.pdf })))
  }
)
