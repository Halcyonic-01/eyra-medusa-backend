import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { loadInvoicePdfStateStep } from "./steps/load-invoice-pdf-state"
import { recordInvoicePdfStep } from "./steps/record-invoice-pdf"
import { renderInvoicePdfStep } from "./steps/render-invoice-pdf"
import { storeInvoicePdfStep } from "./steps/store-invoice-pdf"

export type GenerateInvoicePdfInput = { order_id: string }

/**
 * Draws and stores the tax invoice PDF for one shipped order, once.
 *
 * The order is locked while this runs, and the state is read inside the lock,
 * so two runs at the same moment cannot both draw and store a file: the second
 * finds the first's result and stops. It never issues an invoice number: it
 * only works on the number the order already has, so retrying after any
 * failure, or running it a hundred times, changes nothing once the PDF is
 * stored. Shipping does not wait for this and cannot be held up by it.
 */
export const generateInvoicePdfWorkflow = createWorkflow(
  "generate-invoice-pdf",
  function (input: GenerateInvoicePdfInput) {
    const lockKey = transform({ input }, (data) => `invoice-pdf:${data.input.order_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 90 })

    const state = loadInvoicePdfStateStep({ order_id: input.order_id })
    const render = renderInvoicePdfStep({ state })

    const store = when("render-ok", render, (data) => data.ok).then(() => {
      return storeInvoicePdfStep({ render })
    })

    // `store` is undefined when nothing was drawn, so the record step takes it as it comes.
    const outcome = recordInvoicePdfStep({ state, render, file: store })

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(outcome)
  }
)
