import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { generateInvoicePdfWorkflow } from "../workflows/generate-invoice-pdf"
import {
  invoiceNumberOf,
  pdfFileName,
  storedInvoicePdf,
} from "./invoice-pdf-state"
import { callStorefront } from "./storefront"

export type InvoicePdfResult =
  | { kind: "pdf"; bytes: Buffer; filename: string; stored: boolean; draft: boolean }
  | { kind: "no_invoice"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; code: string; message: string }

async function readStored(container: MedusaContainer, key: string): Promise<Buffer | null> {
  try {
    return Buffer.from(await container.resolve(Modules.FILE).getAsBuffer(key))
  } catch {
    return null
  }
}

async function drawWithoutStoring(
  orderId: string,
  invoiceNumber: string,
  allowUnverified: boolean
): Promise<InvoicePdfResult> {
  const reply = await callStorefront(
    "/api/invoices/render",
    { order_id: orderId, allow_unverified: allowUnverified },
    { timeoutMs: 30000 }
  )
  if (reply.kind !== "answered") {
    return { kind: "unavailable", code: reply.kind, message: reply.message }
  }
  const body = reply.body ?? {}
  if (reply.status === 409) {
    return { kind: "no_invoice", message: String(body.message ?? "This order has no tax invoice yet") }
  }
  if (reply.status !== 200 || typeof body.pdf_base64 !== "string") {
    return {
      kind: "unavailable",
      code: String(body.error ?? `storefront_${reply.status}`),
      message: String(body.message ?? "The invoice could not be drawn"),
    }
  }
  // Whatever is drawn must be for this order's own invoice number.
  if (body.invoice_number !== invoiceNumber) {
    return {
      kind: "unavailable",
      code: "number_mismatch",
      message: "The PDF is for a different invoice number than the order's",
    }
  }
  const bytes = Buffer.from(body.pdf_base64, "base64")
  if (bytes.subarray(0, 5).toString() !== "%PDF-") {
    return { kind: "unavailable", code: "not_a_pdf", message: "The storefront did not send a PDF" }
  }
  return {
    kind: "pdf",
    bytes,
    filename: String(body.filename ?? pdfFileName(invoiceNumber)),
    stored: false,
    draft: body.unverified === true,
  }
}

/**
 * The invoice PDF for an order, for whoever is allowed to ask (the route decides
 * that). The stored copy is returned when there is one. When there is not, it is
 * drawn and stored now, so the first person to ask also saves it for everyone
 * after. If it cannot be stored, or drawn for keeping (for example the seller's
 * GSTIN is missing), the file is still returned when it can be drawn, but never
 * kept. A stored file is never replaced.
 *
 * `draft` lets staff see an invoice that is not yet valid, marked as such.
 */
export async function loadInvoicePdf(
  container: MedusaContainer,
  orderId: string,
  options: { draft?: boolean } = {}
): Promise<InvoicePdfResult> {
  const orders = container.resolve(Modules.ORDER)
  const [order] = (await orders.listOrders({ id: [orderId] }, { select: ["id", "metadata"] })) as {
    id: string
    metadata?: Record<string, unknown> | null
  }[]
  if (!order) return { kind: "not_found", message: "Order not found" }

  const invoiceNumber = invoiceNumberOf(order.metadata)
  if (!invoiceNumber) {
    return { kind: "no_invoice", message: "This order has no tax invoice yet. It is issued when the order ships." }
  }

  const stored = storedInvoicePdf(order.metadata)
  if (stored) {
    const bytes = await readStored(container, stored.key)
    if (bytes) {
      return { kind: "pdf", bytes, filename: pdfFileName(invoiceNumber), stored: true, draft: false }
    }
    // The stored file cannot be read. Draw a copy for now but leave the record
    // as it is: replacing an issued invoice is for a person to decide.
    return drawWithoutStoring(orderId, invoiceNumber, options.draft === true)
  }

  const { result } = await generateInvoicePdfWorkflow(container).run({ input: { order_id: orderId } })
  if (result.status === "stored" || result.status === "exists") {
    const key = result.key
    const bytes = await readStored(container, key)
    if (bytes) {
      return { kind: "pdf", bytes, filename: pdfFileName(invoiceNumber), stored: true, draft: false }
    }
  }
  return drawWithoutStoring(orderId, invoiceNumber, options.draft === true)
}
