import { financialYearLabel } from "../order-dispatch/invoice"

/** Letters and digits only, up to 4 characters, so a number stays short. Default CN. */
export function creditNotePrefix(): string {
  const raw = (process.env.CREDIT_NOTE_PREFIX ?? "CN").trim().toUpperCase()
  return /^[A-Z0-9]{1,4}$/.test(raw) ? raw : "CN"
}

/** For example CN/26-27/0001. Four digits, growing past 9999 without a clash. */
export function formatCreditNoteNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, "0")}`
}

export { financialYearLabel }

/** The folder a credit note's PDF goes in, for example credit-notes/FY26-27/. */
export function creditNoteFolder(fy: string): string {
  const base = (process.env.CREDIT_NOTE_S3_PREFIX ?? "credit-notes/").trim().replace(/^\/+/, "")
  const withSlash = base === "" ? "" : base.endsWith("/") ? base : `${base}/`
  return `${withSlash}FY${fy}/`
}

/** The file name of a credit note's PDF: the number with the slashes made safe. */
export function creditNoteFileName(number: string): string {
  return `${number.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`
}
