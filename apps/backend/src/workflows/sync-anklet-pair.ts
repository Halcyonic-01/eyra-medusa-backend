import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { syncAnkletPairStep } from "./steps/sync-anklet-pair"

export type SyncAnkletPairInput = { product_id: string }

/**
 * Keeps an anklet sellable as Single or Pair, with the Pair at two singles less
 * ₹200. Locked per product, so the events its own changes cause cannot run it twice at once.
 */
export const syncAnkletPairWorkflow = createWorkflow(
  "sync-anklet-pair",
  function (input: SyncAnkletPairInput) {
    const lockKey = transform({ input }, (data) => `anklet-pair:${data.input.product_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })

    const status = syncAnkletPairStep({ product_id: input.product_id })

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(status)
  }
)
