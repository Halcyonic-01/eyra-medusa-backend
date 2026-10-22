import { model } from "@medusajs/framework/utils"

/**
 * A statutory GST credit note (Rule 53, CGST Rules): the document that reverses
 * all or part of a tax invoice after a return, an exchange, or a cancellation
 * or refused delivery that happens after the invoice was issued.
 *
 * Amounts are whole paise so the number can be taken in the same database
 * transaction as the row, which keeps the series free of gaps. `payload` is the
 * document itself, exactly as printed and exported; the columns beside it are
 * for finding, reporting and the monthly GSTR-1 feed.
 *
 * `source_key` says what caused the note ("return:retreq_...", "cancel:order_...")
 * and is unique, so the same event can never produce two notes.
 */
export const CreditNote = model
  .define("credit_note", {
    id: model.id({ prefix: "crn" }).primaryKey(),
    credit_note_number: model.text(),
    /** Financial year label, for example "26-27". */
    fy: model.text(),
    seq: model.number(),
    source_key: model.text(),
    kind: model.enum(["return", "exchange", "cancellation", "rto"]),
    order_id: model.text(),
    return_request_id: model.text().nullable(),
    original_invoice_number: model.text(),
    original_invoice_date: model.text(),
    issued_at: model.dateTime(),
    /** The GSTR-1 month this note is reported in, for example "2026-10". */
    gstr1_period: model.text(),
    taxable_paise: model.number(),
    cgst_paise: model.number(),
    sgst_paise: model.number(),
    igst_paise: model.number(),
    total_paise: model.number(),
    /** Kept back from the value credited (the reverse logistics fee). */
    deduction_paise: model.number().default(0),
    /** What the customer actually gets: the total less the deduction. */
    net_credit_paise: model.number(),
    payload: model.json(),
    /** The stored PDF: its key in the file store, and a checksum of it. */
    pdf_key: model.text().nullable(),
    pdf_sha256: model.text().nullable(),
    pdf_attempts: model.number().default(0),
    pdf_retry_at: model.dateTime().nullable(),
    pdf_error: model.text().nullable(),
  })
  .indexes([
    { on: ["credit_note_number"], unique: true, where: "deleted_at IS NULL" },
    { on: ["source_key"], unique: true, where: "deleted_at IS NULL" },
    { on: ["order_id"] },
    { on: ["gstr1_period"] },
  ])
