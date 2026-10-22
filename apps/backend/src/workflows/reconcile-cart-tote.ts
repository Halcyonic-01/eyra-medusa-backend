import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { reconcileToteStep } from "./steps/reconcile-tote"

export type ReconcileCartToteInput = { cart_id: string }

/**
 * Keeps a cart's complimentary tote bag right after every change: added when
 * the items are worth more than ₹1,499 and the tote is in stock, taken off when
 * they no longer are. Locked per cart, so two quick changes cannot add two.
 */
export const reconcileCartToteWorkflow = createWorkflow(
  "reconcile-cart-tote",
  function (input: ReconcileCartToteInput) {
    const lockKey = transform({ input }, (data) => `tote:${data.input.cart_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const status = reconcileToteStep({ cart_id: input.cart_id })

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(status)
  }
)
