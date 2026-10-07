/**
 * Tax invoice numbering. Invoices are issued per Indian financial year
 * (1 April to 31 March) and numbered in one unbroken series.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** The calendar date as it reads on a clock in India. */
function indiaDate(at: Date): { year: number; month: number; day: number } {
  const ist = new Date(at.getTime() + IST_OFFSET_MS)
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() }
}

/** The financial year a moment falls in, for example "26-27" for 5 Oct 2026. */
export function financialYearLabel(at: Date): string {
  const { year, month } = indiaDate(at)
  const startYear = month >= 4 ? year : year - 1
  const twoDigits = (value: number) => String(value % 100).padStart(2, "0")
  return `${twoDigits(startYear)}-${twoDigits(startYear + 1)}`
}

/** For example EYRA/26-27/00001, which is 16 characters, the most an invoice number may have. */
export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(5, "0")}`
}

/** The invoice date as YYYY-MM-DD in India. */
export function invoiceDate(at: Date): string {
  const { year, month, day } = indiaDate(at)
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
