import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { loadPaymentStanding, STANDING_MESSAGES } from "../../modules/order-dispatch/payment-standing"
import {
  claimDispatch,
  deferDispatchForPayment,
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

/** How long an order with no confirmed payment waits before it is looked at again. */
const PAYMENT_RECHECK_MINUTES = 10

/**
 * Takes the order for dispatching, atomically: only one caller can hold it, and
 * only once its cancel window has closed (unless forced). If the workflow fails
 * afterwards, the order is handed back for a retry instead of being left stuck.
 * An order with no linked checkout or no recorded payment is never taken, not
 * even with "Ship now": it is held back and looked at again later.
 */
export const claimDispatchStep = createStep(
  "claim-dispatch",
  async (input: Input, { container }) => {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg

    const standing = await loadPaymentStanding(container, input.order_id)
    if (!standing.ok) {
      const message = `Not shipped: ${STANDING_MESSAGES[standing.reason]}`
      const held = await deferDispatchForPayment(pg, input.order_id, message, PAYMENT_RECHECK_MINUTES)
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(`[dispatch] order ${input.order_id} held back: ${standing.reason}`)
      const result: DispatchClaim = {
        claimed: false,
        reason: "payment_not_confirmed",
        dispatch: held ? toSnapshot(held) : null,
      }
      return new StepResponse(result, "")
    }

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
