import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  invoiceNumberOf,
  storedInvoicePdf,
  type StoredInvoicePdf,
} from "../../utils/invoice-pdf-state"

export type InvoicePdfState = {
  order_id: string
  /** The invoice number issued at dispatch, or null while the order has none. */
  invoice_number: string | null
  /** The PDF already stored for that number, if any. */
  stored: StoredInvoicePdf | null
}

/**
 * Reads where an order stands: whether it has a tax invoice number, and whether
 * its PDF has already been stored. Everything after this step decides from it,
 * so a repeat run finds the stored file and does nothing.
 */
export const loadInvoicePdfStateStep = createStep(
  "load-invoice-pdf-state",
  async (input: { order_id: string }, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { id: input.order_id },
    })
    const order = data[0] as { id: string; metadata?: Record<string, unknown> | null } | undefined
    if (!order) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `Order ${input.order_id} not found`)
    }
    return new StepResponse<InvoicePdfState>({
      order_id: order.id,
      invoice_number: invoiceNumberOf(order.metadata),
      stored: storedInvoicePdf(order.metadata),
    })
  }
)
