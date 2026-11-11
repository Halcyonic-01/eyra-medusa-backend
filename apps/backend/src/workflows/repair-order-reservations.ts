import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { repairOrderReservationsStep } from "./steps/repair-order-reservations"

/** Restores missing stock reservations for one order, one repair at a time per order. */
export const repairOrderReservationsWorkflow = createWorkflow(
  "repair-order-reservations",
  function (input: { order_id: string }) {
    const lockKey = transform({ input }, (data) => `reservation-repair:${data.input.order_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })
    const result = repairOrderReservationsStep(input)
    releaseLockStep({ key: lockKey })
    return new WorkflowResponse(result)
  }
)
