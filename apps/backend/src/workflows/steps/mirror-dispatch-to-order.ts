import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { invoiceDate } from "../../modules/order-dispatch/invoice"
import type { DispatchFinish } from "./finish-dispatch"

type Input = {
  order_id: string
  finish: DispatchFinish
}

/**
 * Copies the facts the storefront already reads onto the order's metadata once
 * it has shipped: that it shipped, when, and its tax invoice number and date.
 * Medusa merges metadata, so the tracking fields written by the shipping route
 * are kept. Does nothing for any other outcome.
 */
export const mirrorDispatchToOrderStep = createStep(
  "mirror-dispatch-to-order",
  async (input: Input, { container }) => {
    const { finish } = input
    if (finish.state !== "shipped" || !finish.dispatch) {
      return new StepResponse({ mirrored: false })
    }

    const shippedAt = new Date(finish.dispatch.shipped_at ?? Date.now())
    const orderService = container.resolve(Modules.ORDER)
    await orderService.updateOrders(
      { id: input.order_id },
      {
        metadata: {
          dispatch_state: "shipped",
          dispatched_at: shippedAt.toISOString(),
          ...(finish.dispatch.invoice_number
            ? {
                invoice_number: finish.dispatch.invoice_number,
                invoice_date: invoiceDate(shippedAt),
              }
            : {}),
          ...(finish.dispatch.shiprocket_order_id
            ? { shiprocket_order_id: finish.dispatch.shiprocket_order_id }
            : {}),
        },
      }
    )
    return new StepResponse({ mirrored: true })
  }
)
