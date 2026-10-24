import {
  MAX_PDF_ATTEMPTS,
  invoiceNumberOf,
  isDueForPdf,
  pdfFileName,
  retryDelayMinutes,
  storedInvoicePdf,
} from "../invoice-pdf-state"

const shipped = { invoice_number: "EYRA/26-27/00007", invoice_date: "2026-10-18" }
const stored = { key: "eyra/EYRA-26-27-00007-01H.pdf", invoice_number: "EYRA/26-27/00007", generated_at: "2026-10-18T10:00:00Z", sha256: "abc" }
const now = new Date("2026-10-18T12:00:00Z")

describe("storedInvoicePdf", () => {
  it("finds the stored file for this invoice number", () => {
    expect(storedInvoicePdf({ ...shipped, invoice_pdf: stored })?.key).toBe(stored.key)
  })

  it("ignores a file drawn for a different invoice number", () => {
    expect(storedInvoicePdf({ ...shipped, invoice_pdf: { ...stored, invoice_number: "EYRA/26-27/00001" } })).toBeNull()
  })

  it("ignores malformed records", () => {
    expect(storedInvoicePdf({ ...shipped, invoice_pdf: "nope" })).toBeNull()
    expect(storedInvoicePdf({ ...shipped, invoice_pdf: { key: "" } })).toBeNull()
    expect(storedInvoicePdf(null)).toBeNull()
  })
})

describe("isDueForPdf", () => {
  it("needs an invoice number and no stored file", () => {
    expect(isDueForPdf({}, now)).toBe(false)
    expect(isDueForPdf(shipped, now)).toBe(true)
    expect(isDueForPdf({ ...shipped, invoice_pdf: stored }, now)).toBe(false)
  })

  it("waits out the retry time and gives up after the limit", () => {
    expect(isDueForPdf({ ...shipped, invoice_pdf_retry_at: "2026-10-18T12:30:00Z" }, now)).toBe(false)
    expect(isDueForPdf({ ...shipped, invoice_pdf_retry_at: "2026-10-18T11:30:00Z" }, now)).toBe(true)
    expect(isDueForPdf({ ...shipped, invoice_pdf_attempts: MAX_PDF_ATTEMPTS }, now)).toBe(false)
    expect(isDueForPdf({ ...shipped, invoice_pdf_attempts: MAX_PDF_ATTEMPTS - 1 }, now)).toBe(true)
  })
})

describe("helpers", () => {
  it("backs off", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelayMinutes)).toEqual([5, 10, 20, 40, 80, 160, 160])
  })

  it("makes safe file names", () => {
    expect(pdfFileName("EYRA/26-27/00007")).toBe("EYRA-26-27-00007.pdf")
    expect(pdfFileName("../x y")).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
    expect(invoiceNumberOf({ invoice_number: "  EYRA/26-27/00007 " })).toBe("EYRA/26-27/00007")
  })
})
