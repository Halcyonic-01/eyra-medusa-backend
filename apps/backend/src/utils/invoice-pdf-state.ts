/**
 * What is known about an order's invoice PDF, kept on the order's metadata.
 *
 * The tax invoice number is issued when the order ships and never changes. The
 * PDF is drawn from the order by the storefront and then stored once, so asking
 * again finds the stored file instead of drawing a second one.
 */

export type StoredInvoicePdf = {
  /** The key the file service gave the stored file. */
  key: string
  /** The invoice number this file was drawn for. */
  invoice_number: string
  generated_at: string
  sha256: string
}

type Metadata = Record<string, unknown> | null | undefined

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

export function invoiceNumberOf(metadata: Metadata): string | null {
  return text(metadata?.invoice_number) || null
}

/** The stored PDF, if there is one and it belongs to the order's current invoice number. */
export function storedInvoicePdf(metadata: Metadata): StoredInvoicePdf | null {
  const raw = metadata?.invoice_pdf
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const key = text(record.key)
  const number = text(record.invoice_number)
  if (!key || !number) return null
  // A file for some other invoice number is not this order's invoice.
  if (number !== invoiceNumberOf(metadata)) return null
  return {
    key,
    invoice_number: number,
    generated_at: text(record.generated_at),
    sha256: text(record.sha256),
  }
}

export const MAX_PDF_ATTEMPTS = 6

/** Minutes to wait after a failed attempt: 5, 10, 20, 40, 80, then 160. */
export function retryDelayMinutes(attempts: number): number {
  return 5 * 2 ** Math.max(0, Math.min(attempts - 1, 5))
}

/** Whether the job should try this order now. */
export function isDueForPdf(metadata: Metadata, now: Date): boolean {
  if (!invoiceNumberOf(metadata)) return false
  if (storedInvoicePdf(metadata)) return false
  const attempts = Number(metadata?.invoice_pdf_attempts ?? 0) || 0
  if (attempts >= MAX_PDF_ATTEMPTS) return false
  const retryAt = text(metadata?.invoice_pdf_retry_at)
  return !retryAt || new Date(retryAt).getTime() <= now.getTime()
}

export function pdfFileName(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`
}
