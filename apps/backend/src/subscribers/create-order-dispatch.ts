import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { dispatchEnabled, holdMinutes } from "../modules/order-dispatch/config"
import { postToStorefront } from "../utils/storefront"
import { createOrderDispatchWorkflow } from "../workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../workflows/dispatch-order"

/**
 * When an order is placed, start tracking it for dispatch. With no hold, its
 * shipment is created straight away; otherwise it waits for the cancel window
 * to close and the team is told so they can start preparing in the meantime.
 */
export default async function createOrderDispatchHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!dispatchEnabled()) {
    return
  }

  let recorded = false
  try {
    const windowMinutes = holdMinutes()
    const { result } = await createOrderDispatchWorkflow(container).run({
      input: { order_id: data.id, window_minutes: windowMinutes },
    })
    recorded = true
    if (!result.created) {
      return
    }

    if (windowMinutes <= 0) {
      // Nothing to hold. The scheduled job would also pick this up within a minute.
      await dispatchOrderWorkflow(container).run({ input: { order_id: data.id } })
      return
    }

    await postToStorefront(
      "/api/ops/notify",
      {
        type: "order_held",
        order_id: data.id,
        cancel_until: result.dispatch.window_ends_at,
        window_minutes: windowMinutes,
      },
      logger
    )
  } catch (error) {
    // Never block order placement on dispatch bookkeeping, but make it loud:
    // an order with no dispatch record never ships on its own.
    logger.error(
      `[dispatch] could not start dispatch for order ${data.id}: ${(error as Error).message}`
    )
    if (recorded) {
      // The record exists, so the dispatch job retries the shipment itself.
      return
    }
    // The dispatch job recreates the record within a few minutes; say so now.
    await postToStorefront(
      "/api/ops/notify",
      { type: "dispatch_not_started", order_id: data.id, error: (error as Error).message },
      logger
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
