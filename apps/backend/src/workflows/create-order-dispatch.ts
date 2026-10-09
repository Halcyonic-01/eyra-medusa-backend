import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createOrderDispatchStep } from "./steps/create-order-dispatch"

export type CreateOrderDispatchInput = {
  order_id: string
  /** How long the order is held before its shipment is created. */
  window_minutes: number
  /** When the window closes, if not `window_minutes` from now. */
  window_ends_at?: string
}

/**
 * Starts tracking a newly placed order: it is held for the cancel window, then
 * its shipment is created. Safe to run more than once for the same order.
 */
export const createOrderDispatchWorkflow = createWorkflow(
  "create-order-dispatch",
  function (input: CreateOrderDispatchInput) {
    const result = createOrderDispatchStep(input)
    return new WorkflowResponse(result)
  }
)
