import { Module } from "@medusajs/framework/utils"
import CreditNoteModuleService from "./service"

export const CREDIT_NOTE_MODULE = "creditNote"

export default Module(CREDIT_NOTE_MODULE, {
  service: CreditNoteModuleService,
})
