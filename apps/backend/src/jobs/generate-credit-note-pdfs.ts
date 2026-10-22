import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { CREDIT_NOTE_MODULE } from "../modules/credit-note"
import type CreditNoteModuleService from "../modules/credit-note/service"
import { MAX_PDF_ATTEMPTS } from "../utils/invoice-pdf-state"
import { postToStorefront } from "../utils/storefront"
import { generateCreditNotePdfWorkflow } from "../workflows/generate-credit-note-pdf"

/** How many notes one run draws, so a backlog cannot swamp the storefront. */
const BATCH = 20

/**
 * Draws and stores the PDF of credit notes that have none yet: ones whose first
 * attempt failed, or that were saved while the storefront was down. Retries with
 * a growing delay, and the team is told once when one keeps failing.
 */
export default async function generateCreditNotePdfsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: CreditNoteModuleService = container.resolve(CREDIT_NOTE_MODULE)

  const pending = await service.listCreditNotes({ pdf_key: null }, { take: 200, order: { created_at: "ASC" } })
  const now = Date.now()
  const due = pending
    .filter((note) => (note.pdf_attempts ?? 0) < MAX_PDF_ATTEMPTS)
    .filter((note) => !note.pdf_retry_at || new Date(note.pdf_retry_at).getTime() <= now)
    .slice(0, BATCH)

  for (const note of due) {
    try {
      const { result } = await generateCreditNotePdfWorkflow(container).run({ input: { credit_note_id: note.id } })
      if (result.status === "stored") {
        logger.info(`[credit-note] stored the PDF for ${note.credit_note_number}`)
      } else if (result.status === "failed") {
        logger.warn(`[credit-note] ${note.credit_note_number}: ${result.code}: ${result.message} (attempt ${result.attempts})`)
        if (result.gave_up) {
          await postToStorefront(
            "/api/ops/notify",
            {
              type: "credit_note_pdf_failed",
              order_id: note.order_id,
              credit_note_number: note.credit_note_number,
              attempts: result.attempts,
              error: `${result.code}: ${result.message}`,
            },
            logger
          )
        }
      }
    } catch (error) {
      logger.error(`[credit-note] could not draw ${note.credit_note_number}: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "generate-credit-note-pdfs",
  schedule: "*/5 * * * *",
}
