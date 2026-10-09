import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MAX_DISPATCH_ATTEMPTS, STALLED_AFTER_MINUTES } from "../../modules/order-dispatch/config"
import { flagStalledCancellations, recoverStalled, type Pg } from "../../modules/order-dispatch/transitions"
import { postToStorefront } from "../../utils/storefront"

/**
 * Hands back orders left `dispatching` by a worker that stopped halfway, so the
 * next run retries them. Tells staff when one has used up all its attempts.
 */
export const recoverStalledDispatchesStep = createStep(
  "recover-stalled-dispatches",
  async (_input: void, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg

    const recovered = await recoverStalled(pg, STALLED_AFTER_MINUTES)
    for (const item of recovered) {
      logger.warn(`[dispatch] order ${item.order_id} was interrupted mid-dispatch, retrying`)
      if (Number(item.attempts) >= MAX_DISPATCH_ATTEMPTS) {
        await postToStorefront(
          "/api/ops/notify",
          {
            type: "dispatch_failed",
            order_id: item.order_id,
            order_ref: null,
            attempts: Number(item.attempts),
            max_attempts: MAX_DISPATCH_ATTEMPTS,
            will_retry: false,
            error: "Dispatch was interrupted before it finished",
          },
          logger
        )
      }
    }

    // A cancellation that stopped halfway may have moved money, so it is only
    // reported, never retried on its own.
    for (const orderId of await flagStalledCancellations(pg, STALLED_AFTER_MINUTES)) {
      logger.warn(`[cancel] cancellation of ${orderId} was interrupted, needs a person`)
      await postToStorefront(
        "/api/ops/notify",
        { type: "cancellation_stalled", order_id: orderId },
        logger
      )
    }

    return new StepResponse({ recovered: recovered.map((item) => item.order_id) })
  }
)
