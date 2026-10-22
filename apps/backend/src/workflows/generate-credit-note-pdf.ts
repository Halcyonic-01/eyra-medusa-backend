import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { renderStoreCreditNotePdfStep } from "./steps/render-store-credit-note-pdf"

export type GenerateCreditNotePdfInput = { credit_note_id: string }

/**
 * Draws and stores the PDF of one credit note, once. Locked per note, so two runs
 * at the same moment cannot store two files. It never changes the note's number
 * or content; it only attaches the file.
 */
export const generateCreditNotePdfWorkflow = createWorkflow(
  "generate-credit-note-pdf",
  function (input: GenerateCreditNotePdfInput) {
    const lockKey = transform({ input }, (data) => `credit-note-pdf:${data.input.credit_note_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 90 })

    const outcome = renderStoreCreditNotePdfStep({ credit_note_id: input.credit_note_id })

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(outcome)
  }
)
