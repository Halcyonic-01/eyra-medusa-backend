import type { CreditNoteDocument } from "./document"

/**
 * The monthly credit note feed for GSTR-1 filing: one row per credit note line,
 * with the seller's and recipient's GSTIN, the credit note and its original
 * invoice, the HSN or SAC, the taxable value and the CGST, SGST and IGST.
 *
 * After a note's lines come the fee on it, if any (the reverse logistics fee kept
 * from a return), as its own row under SAC 9997
 * at 18%. "Row Type" says which kind each row is: a credit note line reverses the
 * invoice; a fee row is the service charged, with its own GST.
 *
 * Amounts are rupees with two decimals. Text is quoted, and anything that could
 * be read as a spreadsheet formula (a customer's name starting with =, +, - or @)
 * is defused with a leading apostrophe.
 */

export const GSTR1_COLUMNS = [
  "Seller GSTIN",
  "Recipient GSTIN",
  "Recipient Name",
  "Place of Supply (State Code)",
  "Credit Note Number",
  "Credit Note Date",
  "Original Invoice Number",
  "Original Invoice Date",
  "HSN/SAC",
  "Description",
  "Quantity",
  "GST Rate (%)",
  "Taxable Value",
  "CGST",
  "SGST",
  "IGST",
  "Total",
  "Row Type",
] as const

export type Gstr1Note = { payload: CreditNoteDocument }

const FORMULA_START = /^[=+\-@\t\r]/

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'
  if (typeof value === "number") return value.toFixed(2)
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

const whole = (value: number) => String(value)
const day = (iso: string | null) => (iso ?? "").slice(0, 10)

export function gstr1Csv(notes: readonly Gstr1Note[]): string {
  const rows: string[] = [GSTR1_COLUMNS.map((name) => `"${name}"`).join(",")]
  for (const { payload } of notes) {
    for (const line of payload.line_items) {
      rows.push(
        [
          cell(payload.seller.gstin),
          cell(payload.customer_details.gstin ?? ""),
          cell(payload.customer_details.name),
          cell(payload.place_of_supply.state_code),
          cell(payload.credit_note_number),
          cell(day(payload.credit_note_date)),
          cell(payload.original_invoice_number),
          cell(day(payload.original_invoice_date)),
          cell(line.hsn_sac),
          cell(line.description),
          whole(line.quantity),
          line.gst_rate.toFixed(2),
          cell(line.taxable_value),
          cell(line.cgst),
          cell(line.sgst),
          cell(line.igst),
          cell(line.total),
          cell("Credit note line"),
        ].join(",")
      )
    }

    const fee = payload.adjustments.fee
    if (fee) {
      rows.push(
        [
          cell(payload.seller.gstin),
          cell(payload.customer_details.gstin ?? ""),
          cell(payload.customer_details.name),
          cell(payload.place_of_supply.state_code),
          cell(payload.credit_note_number),
          cell(day(payload.credit_note_date)),
          cell(payload.original_invoice_number),
          cell(day(payload.original_invoice_date)),
          cell(fee.sac),
          cell(fee.description),
          "1",
          fee.gst_rate.toFixed(2),
          cell(fee.taxable_value),
          cell(fee.cgst),
          cell(fee.sgst),
          cell(fee.igst),
          cell(fee.amount),
          cell("Fee retained"),
        ].join(",")
      )
    }
  }
  return `${rows.join("\r\n")}\r\n`
}
