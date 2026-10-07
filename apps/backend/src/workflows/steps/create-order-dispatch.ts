import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { toSnapshot, type DispatchRow, type DispatchSnapshot } from "../../modules/order-dispatch/transitions"

type Input = {
  order_id: string
  window_minutes: number
  /** When the window closes, if not `window_minutes` from now (a recovered order keeps its original window). */
  window_ends_at?: string
}

export type CreatedOrderDispatch = {
  created: boolean
  dispatch: DispatchSnapshot
}

/**
 * Starts tracking an order for dispatch. Idempotent: an order that already has
 * a record keeps it, so a repeated "order placed" event changes nothing.
 */
export const createOrderDispatchStep = createStep(
  "create-order-dispatch",
  async (input: Input, { container }) => {
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)

    const [existing] = await service.listOrderDispatches({ order_id: input.order_id }, { take: 1 })
    if (existing) {
      const result: CreatedOrderDispatch = {
        created: false,
        dispatch: toSnapshot(existing as unknown as DispatchRow),
      }
      return new StepResponse(result, "")
    }

    const windowEndsAt = input.window_ends_at
      ? new Date(input.window_ends_at)
      : new Date(Date.now() + input.window_minutes * 60 * 1000)

    try {
      const created = await service.createOrderDispatches({
        order_id: input.order_id,
        state: "placed",
        window_ends_at: windowEndsAt,
      })
      const result: CreatedOrderDispatch = {
        created: true,
        dispatch: toSnapshot(created as unknown as DispatchRow),
      }
      return new StepResponse(result, created.id)
    } catch (error) {
      // A concurrent event may have created the record first (the order id is
      // unique). Use that one rather than failing.
      const [winner] = await service.listOrderDispatches({ order_id: input.order_id }, { take: 1 })
      if (!winner) {
        throw error
      }
      const result: CreatedOrderDispatch = {
        created: false,
        dispatch: toSnapshot(winner as unknown as DispatchRow),
      }
      return new StepResponse(result, "")
    }
  },
  async (createdId, { container }) => {
    if (!createdId) {
      return
    }
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    await service.deleteOrderDispatches(createdId)
  }
)
