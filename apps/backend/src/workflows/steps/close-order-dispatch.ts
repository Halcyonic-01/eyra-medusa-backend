import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { markCancelled, type Pg } from "../../modules/order-dispatch/transitions"

type Input = {
  order_id: string
}

export type ClosedOrderDispatch = {
  /** The order was still waiting, and is now closed so it will never ship. */
  closed: boolean
  /** The order's shipment already exists, or is being created, so it needs a person. */
  needs_attention: boolean
  state: string | null
}

/**
 * Runs when an order is cancelled. If its shipment has not been created, the
 * order is closed so the dispatcher never ships it. If a shipment already
 * exists (or is being made) it cannot be stopped from here, so that is reported.
 */
export const closeOrderDispatchStep = createStep(
  "close-order-dispatch",
  async (input: Input, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg

    const row = await markCancelled(pg, input.order_id, ["placed", "dispatch_failed", "cancelling"])
    if (row) {
      logger.info(`[dispatch] order ${input.order_id} cancelled before shipping, dispatch closed`)
      const result: ClosedOrderDispatch = { closed: true, needs_attention: false, state: "cancelled" }
      return new StepResponse(result)
    }

    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [existing] = await service.listOrderDispatches({ order_id: input.order_id }, { take: 1 })
    const state = existing?.state ?? null
    const result: ClosedOrderDispatch = {
      closed: false,
      needs_attention: state === "shipped" || state === "dispatching",
      state,
    }
    return new StepResponse(result)
  }
)
