import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { CancelReason, RefundMethod } from "../modules/order-dispatch/cancellation"
import { executeCancellationStep } from "./steps/execute-cancellation"
import { loadCancellationContextStep } from "./steps/load-cancellation-context"
import { notifyCancellationStep } from "./steps/notify-cancellation"
import { planCancellationStep } from "./steps/plan-cancellation"

export type CustomerCancelOrderInput = {
  order_id: string
  /** The signed-in customer asking, who must own the order. */
  customer_id: string
  /** Where the money paid online should go. Needed only when something was paid online. */
  refund_method?: RefundMethod
  reason: CancelReason
  note?: string | null
}

/**
 * A customer cancels their own order before its shipment is created, and
 * chooses where the money they paid online goes: their wallet in full, or the
 * original payment method less the cancellation fee.
 */
export const customerCancelOrderWorkflow = createWorkflow(
  "customer-cancel-order",
  function (input: CustomerCancelOrderInput) {
    const context = loadCancellationContextStep({ order_id: input.order_id })

    const planned = planCancellationStep(
      transform({ input, context }, (data) => ({
        context: data.context,
        customer_id: data.input.customer_id,
        refund_method: data.input.refund_method,
      }))
    )

    const outcome = executeCancellationStep(
      transform({ input, context, planned }, (data) => ({
        context: data.context,
        planned: data.planned,
        customer_id: data.input.customer_id,
        reason: data.input.reason,
        note: data.input.note,
      }))
    )

    notifyCancellationStep(
      transform({ input, context, outcome }, (data) => ({
        context: data.context,
        outcome: data.outcome,
        reason: data.input.reason,
        note: data.input.note,
      }))
    )

    return new WorkflowResponse(outcome)
  }
)
