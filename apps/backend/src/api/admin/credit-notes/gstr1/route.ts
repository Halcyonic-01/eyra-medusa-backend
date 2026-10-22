import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_NOTE_MODULE } from "../../../../modules/credit-note"
import { gstr1Csv } from "../../../../modules/credit-note/gstr1"
import type CreditNoteModuleService from "../../../../modules/credit-note/service"
import type { CreditNoteDocument } from "../../../../modules/credit-note/document"
import type { Gstr1Query } from "../validation"

/**
 * GET /admin/credit-notes/gstr1?month=2026-10
 *
 * The month's credit notes as a CSV for GSTR-1: seller and recipient GSTIN,
 * credit note number, original invoice number, HSN or SAC, taxable value, CGST,
 * SGST and IGST, one row per credit note line. A month with none is a file with
 * only its header.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service: CreditNoteModuleService = req.scope.resolve(CREDIT_NOTE_MODULE)
  const { month } = req.validatedQuery as unknown as Gstr1Query

  const notes = await service.listCreditNotes({ gstr1_period: month }, { order: { seq: "ASC" }, take: 10000 })
  const csv = gstr1Csv(notes.map((note) => ({ payload: note.payload as unknown as CreditNoteDocument })))

  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="gstr1-credit-notes-${month}.csv"`)
  res.setHeader("Cache-Control", "private, no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  return res.status(200).end(csv)
}
