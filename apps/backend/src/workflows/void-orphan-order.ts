import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { checkOrphanStep, voidOrphanOrderStep } from "./steps/void-orphan-order"

/**
 * Voids an order left by an interrupted checkout, if and only if it is one (see
 * orphanVerdict). Takes the same lock as Medusa's cart completion for that cart,
 * so it can never act while that cart is being completed.
 */
export const voidOrphanOrderWorkflow = createWorkflow(
  "void-orphan-order",
  function (input: { order_id: string }) {
    const verdict = checkOrphanStep(input)

    const result = when("is-orphan", { verdict }, (data) => data.verdict.void).then(() => {
      const cartLock = transform({ verdict }, (data) => (data.verdict as { cart_id: string }).cart_id)
      acquireLockStep({ key: cartLock, timeout: 30, ttl: 120 })
      const voided = voidOrphanOrderStep(input)
      releaseLockStep({ key: cartLock })
      return voided
    })

    return new WorkflowResponse(
      transform({ verdict, result }, (data) => data.result ?? { voided: false, reason: (data.verdict as { reason?: string }).reason ?? "not_orphan" })
    )
  }
)
