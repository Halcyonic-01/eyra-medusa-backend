import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import {
  claimDispatch,
  markDispatchFailed,
  toSnapshot,
  type DispatchRow,
  type DispatchSnapshot,
  type Pg,
} from "../../modules/order-dispatch/transitions"

type Input = {
  order_id: string
  /** Skip the cancel window and any retry delay ("Ship now"). */
  force?: boolean
}

export type DispatchClaim = {
  claimed: boolean
  /** Why nothing was claimed, when nothing was. */
  reason: string
  dispatch: DispatchSnapshot | null
}

const REASONS: Record<string, string> = {
  placed: "window_open",
  dispatching: "already_dispatching",
  dispatch_failed: "retry_not_due",
  shipped: "already_shipped",
  cancelling: "cancelled",
  cancelled: "cancelled",
}

/**
 * Takes the order for dispatching, atomically: only one caller can hold it, and
 * only once its cancel window has closed (unless forced). If the workflow fails
 * afterwards, the order is handed back for a retry instead of being left stuck.
 */
export const claimDispatchStep = createStep(
  "claim-dispatch",
  async (input: Input, { container }) => {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg

    const row = await claimDispatch(pg, input.order_id, input.force === true)
    if (row) {
      const result: DispatchClaim = { claimed: true, reason: "claimed", dispatch: toSnapshot(row) }
      return new StepResponse(result, input.order_id)
    }

    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [existing] = await service.listOrderDispatches({ order_id: input.order_id }, { take: 1 })
    const result: DispatchClaim = existing
      ? {
          claimed: false,
          reason: REASONS[existing.state] ?? "not_due",
          dispatch: toSnapshot(existing as unknown as DispatchRow),
        }
      : { claimed: false, reason: "no_dispatch_record", dispatch: null }
    // Nothing was claimed, so there is nothing to hand back if the workflow fails.
    return new StepResponse(result, "")
  },
  async (orderId, { container }) => {
    if (!orderId) {
      return
    }
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    // Only acts if the order is still `dispatching`, so a finished shipment is untouched.
    await markDispatchFailed(pg, orderId, "Dispatch stopped by an unexpected error", 1)
  }
)
