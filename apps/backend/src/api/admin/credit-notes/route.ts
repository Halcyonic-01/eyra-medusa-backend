import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_NOTE_MODULE } from "../../../modules/credit-note"
import type CreditNoteModuleService from "../../../modules/credit-note/service"
import type { ListCreditNotesQuery } from "./validation"

/**
 * GET /admin/credit-notes?order_id=&month=2026-10
 *
 * Credit notes newest first, for an order or a GSTR-1 month. Each carries the
 * whole document as issued, plus whether its PDF is stored.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service: CreditNoteModuleService = req.scope.resolve(CREDIT_NOTE_MODULE)
  const { order_id, month, limit, offset } = req.validatedQuery as unknown as ListCreditNotesQuery

  const filters: Record<string, unknown> = {}
  if (order_id) filters.order_id = order_id
  if (month) filters.gstr1_period = month

  const [notes, count] = await service.listAndCountCreditNotes(filters, {
    take: limit,
    skip: offset,
    order: { issued_at: "DESC" },
  })

  return res.json({
    credit_notes: notes.map((note) => ({
      id: note.id,
      credit_note_number: note.credit_note_number,
      kind: note.kind,
      order_id: note.order_id,
      return_request_id: note.return_request_id,
      original_invoice_number: note.original_invoice_number,
      issued_at: note.issued_at,
      gstr1_period: note.gstr1_period,
      total: note.total_paise / 100,
      deduction: note.deduction_paise / 100,
      net_credit: note.net_credit_paise / 100,
      has_pdf: Boolean(note.pdf_key),
      pdf_error: note.pdf_error,
      document: note.payload,
    })),
    count,
    limit,
    offset,
  })
}
