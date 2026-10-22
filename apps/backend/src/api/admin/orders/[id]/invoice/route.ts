import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadInvoicePdf } from "../../../../../utils/invoice-pdf-access"

/**
 * GET /admin/orders/:id/invoice
 *
 * The order's GST tax invoice as a PDF, for staff packing the shipment and for
 * the storefront, which serves it to the customer who owns the order after
 * checking that they do. It is behind the admin sign-in like every admin route.
 *
 *   ?download=1   save the file instead of showing it
 *   ?draft=1      also draw an invoice that is not yet valid (for example the
 *                 seller's GSTIN is missing). It is marked as not valid and is
 *                 never stored.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  if (typeof orderId !== "string" || !orderId.startsWith("order_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid order id is required")
  }

  const result = await loadInvoicePdf(req.scope, orderId, { draft: req.query.draft === "1" })

  switch (result.kind) {
    case "not_found":
      return res.status(404).json({ code: "order_not_found", message: result.message })
    case "no_invoice":
      return res.status(409).json({ code: "no_invoice", message: result.message })
    case "unavailable":
      return res
        .status(result.code === "invoice_not_valid" ? 422 : 503)
        .json({ code: result.code, message: result.message })
    case "pdf": {
      const disposition = req.query.download === "1" ? "attachment" : "inline"
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader("Content-Disposition", `${disposition}; filename="${result.filename}"`)
      res.setHeader("Content-Length", String(result.bytes.length))
      // An invoice is private: nothing may keep a shared copy.
      res.setHeader("Cache-Control", "private, no-store")
      res.setHeader("X-Content-Type-Options", "nosniff")
      res.setHeader("X-Invoice-Stored", result.stored ? "true" : "false")
      return res.status(200).end(result.bytes)
    }
  }
}
