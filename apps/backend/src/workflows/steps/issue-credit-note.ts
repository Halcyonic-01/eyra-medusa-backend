import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { issueCreditNote, type IssueCreditNoteInput } from "../../modules/credit-note/issue"

export type IssuedCreditNote = {
  status: "issued" | "exists"
  credit_note_id: string
  credit_note_number: string
  total_paise: number
  deduction_paise: number
  net_credit_paise: number
}

/**
 * Issues a credit note and numbers it. There is deliberately no undo: an issued
 * number is never taken back, because a gap in the series is worse than a note
 * that is later cancelled by another note.
 */
export const issueCreditNoteStep = createStep("issue-credit-note", async (input: IssueCreditNoteInput, { container }) => {
  const { status, note } = await issueCreditNote(container, input)
  return new StepResponse<IssuedCreditNote>({
    status,
    credit_note_id: note.id,
    credit_note_number: note.credit_note_number,
    total_paise: Number(note.total_paise),
    deduction_paise: Number(note.deduction_paise),
    net_credit_paise: Number(note.net_credit_paise),
  })
})
