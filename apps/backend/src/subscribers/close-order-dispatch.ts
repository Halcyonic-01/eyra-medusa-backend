import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { dispatchEnabled } from "../modules/order-dispatch/config"
import { postToStorefront } from "../utils/storefront"
import { closeOrderDispatchWorkflow } from "../workflows/close-order-dispatch"

/**
 * When an order is cancelled, make sure it is never shipped. If a shipment
 * already exists, tell the team so the parcel can be stopped.
 */
export default async function closeOrderDispatchHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!dispatchEnabled()) {
    return
  }

  try {
    const { result } = await closeOrderDispatchWorkflow(container).run({
      input: { order_id: data.id },
    })
    if (result.needs_attention) {
      await postToStorefront(
        "/api/ops/notify",
        { type: "cancelled_after_shipment", order_id: data.id, state: result.state },
        logger
      )
    }
  } catch (error) {
    logger.error(
      `[dispatch] could not close dispatch for cancelled order ${data.id}: ${(error as Error).message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
