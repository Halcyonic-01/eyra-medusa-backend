import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { CREDIT_NOTE_MODULE } from "../modules/credit-note"
import type { CreditNoteDocument } from "../modules/credit-note/document"
import { gstr1Csv } from "../modules/credit-note/gstr1"
import type CreditNoteModuleService from "../modules/credit-note/service"
import { storeGstr1Csv } from "../modules/credit-note/storage"

/** The month before `now`, in India, as 2026-09. */
export function previousMonth(now: Date): string {
  const shifted = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  const year = shifted.getUTCMonth() === 0 ? shifted.getUTCFullYear() - 1 : shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() === 0 ? 12 : shifted.getUTCMonth()
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * On the 1st of each month, writes last month's credit notes to the file store
 * as a GSTR-1 CSV (gstr1/ folder), ready for the person who files. The same
 * file can be downloaded any time from the admin route
 * GET /admin/credit-notes/gstr1?month=YYYY-MM.
 */
export default async function exportGstr1CreditNotesJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: CreditNoteModuleService = container.resolve(CREDIT_NOTE_MODULE)
  const month = previousMonth(new Date())

  const notes = await service.listCreditNotes({ gstr1_period: month }, { order: { seq: "ASC" }, take: 10000 })
  if (!notes.length) {
    logger.info(`[gstr1] no credit notes in ${month}, nothing to export`)
    return
  }
  const csv = gstr1Csv(notes.map((note) => ({ payload: note.payload as unknown as CreditNoteDocument })))
  const { key } = await storeGstr1Csv(container, month, csv)
  logger.info(`[gstr1] exported ${notes.length} credit note(s) for ${month} to ${key}`)
}

export const config = {
  name: "export-gstr1-credit-notes",
  schedule: "0 3 1 * *",
}
