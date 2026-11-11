import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, emitEventStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { authorizeRecoveredPaymentStep } from "./steps/authorize-recovered-payment"
import { planPaymentRepairStep } from "./steps/plan-payment-repair"

export type RepairOrderPaymentInput = { order_id: string }

/**
 * Gives a placed order the payment record a crash left out, once it is proven
 * paid (see the plan step), then announces the order as placed again so the
 * steps that were lost with it run: dispatch tracking and wallet redemption,
 * both of which ignore a repeat.
 */
export const repairOrderPaymentWorkflow = createWorkflow(
  "repair-order-payment",
  function (input: RepairOrderPaymentInput) {
    const lockKey = transform({ input }, (data) => `payment-repair:${data.input.order_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })

    const plan = planPaymentRepairStep({ order_id: input.order_id })

    when("payment-can-be-recorded", { plan }, (data) => data.plan.action === "authorize").then(() => {
      const sessionInput = transform({ plan }, (data) => ({ session_id: (data.plan as { session_id: string }).session_id }))
      authorizeRecoveredPaymentStep(sessionInput)
      emitEventStep({ eventName: "order.placed", data: { id: input.order_id } })
    })

    releaseLockStep({ key: lockKey })
    return new WorkflowResponse(plan)
  }
)
