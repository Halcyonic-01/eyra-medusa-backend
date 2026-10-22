import { MedusaService } from "@medusajs/framework/utils"
import { CreditNote } from "./models/credit-note"
import { CreditNoteCounter } from "./models/credit-note-counter"

class CreditNoteModuleService extends MedusaService({
  CreditNote,
  CreditNoteCounter,
}) {}

export default CreditNoteModuleService
