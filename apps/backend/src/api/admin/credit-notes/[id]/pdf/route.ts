import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { CREDIT_NOTE_MODULE } from "../../../../../modules/credit-note"
import { creditNoteFileName } from "../../../../../modules/credit-note/config"
import { readCreditNotePdf } from "../../../../../modules/credit-note/storage"
import type CreditNoteModuleService from "../../../../../modules/credit-note/service"
import { generateCreditNotePdfWorkflow } from "../../../../../workflows/generate-credit-note-pdf"

/**
 * GET /admin/credit-notes/:id/pdf
 *
 * The credit note's PDF. If it has not been stored yet it is drawn and stored
 * now, so the first request also saves it for everyone after. Behind the admin
 * sign-in like every admin route: the storefront serves it to the customer who
 * owns the order after checking that they do.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const id = req.params.id
  if (typeof id !== "string" || !id.startsWith("crn_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid credit note id is required")
  }
  const service: CreditNoteModuleService = req.scope.resolve(CREDIT_NOTE_MODULE)
  const [note] = await service.listCreditNotes({ id }, { take: 1 })
  if (!note) return res.status(404).json({ code: "credit_note_not_found", message: "Credit note not found" })

  let key = note.pdf_key
  if (!key) {
    const { result } = await generateCreditNotePdfWorkflow(req.scope).run({ input: { credit_note_id: id } })
    if (result.status === "failed") {
      return res.status(503).json({ code: result.code, message: result.message })
    }
    key = result.key
  }
  const bytes = await readCreditNotePdf(req.scope, key, note.fy)
  if (!bytes) return res.status(503).json({ code: "unreadable", message: "The stored PDF could not be read" })

  const disposition = req.query.download === "1" ? "attachment" : "inline"
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `${disposition}; filename="${creditNoteFileName(note.credit_note_number)}"`)
  res.setHeader("Content-Length", String(bytes.length))
  res.setHeader("Cache-Control", "private, no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  return res.status(200).end(bytes)
}
