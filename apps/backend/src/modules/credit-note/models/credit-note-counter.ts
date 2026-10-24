import { model } from "@medusajs/framework/utils"

/**
 * The last credit note number issued in each financial year. A number is only
 * taken inside the same transaction that saves the note, so a note that fails
 * to save never leaves a gap in the series.
 */
export const CreditNoteCounter = model
  .define("credit_note_counter", {
    id: model.id({ prefix: "crnc" }).primaryKey(),
    /** Financial year label, for example "26-27". */
    fy: model.text(),
    last_seq: model.number().default(0),
  })
  .indexes([{ on: ["fy"], unique: true, where: "deleted_at IS NULL" }])
