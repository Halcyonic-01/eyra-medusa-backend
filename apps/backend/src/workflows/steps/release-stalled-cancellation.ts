import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { releaseCancelling, type Pg } from "../../modules/order-dispatch/transitions"

type Input = { order_id: string }

/**
 * Puts an order back in its cancel window when a cancellation stopped before
 * any money moved. Refused once a refund may have been sent: then the refund
 * must be checked and finished with "Retry refund" instead.
 */
export const releaseStalledCancellationStep = createStep(
  "release-stalled-cancellation",
  async (input: Input, { container }) => {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)

    const [record] = await service.listOrderCancellations({ order_id: input.order_id }, { take: 1 })
    if (record && record.refund_status !== "pending" && record.refund_status !== "not_needed") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "A refund may already have been sent for this order. Check it in Razorpay and use Retry refund.",
        "refund_may_have_moved"
      )
    }

    const released = await releaseCancelling(pg, input.order_id)
    if (!released) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This order is not waiting on a cancellation", "not_cancelling")
    }
    if (record) {
      await service.deleteOrderCancellations(record.id)
    }
    return new StepResponse({ order_id: input.order_id, state: released.state })
  }
)
