import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  dispatchEnabled,
  holdMinutes,
  MAX_DISPATCH_ATTEMPTS,
} from "../modules/order-dispatch/config"
import { ORDER_DISPATCH_MODULE } from "../modules/order-dispatch"
import { dispatchConfigProblems } from "../modules/order-dispatch/config"
import { findOrdersMissingDispatch, findUncapturedPrepaidOrders } from "../modules/order-dispatch/missing-dispatches"
import type OrderDispatchModuleService from "../modules/order-dispatch/service"
import { postToStorefront } from "../utils/storefront"
import { createOrderDispatchWorkflow } from "../workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../workflows/dispatch-order"
import { recoverStalledDispatchesWorkflow } from "../workflows/recover-stalled-dispatches"

/** Orders handled per run, so one slow courier call cannot back up the whole queue. */
const BATCH_SIZE = 10

/**
 * Every minute: give a dispatch record to any order that missed one, create the
 * shipment for orders whose cancel window has closed, and retry ones whose last
 * attempt failed. Safe to overlap with itself or with "Ship now", because each
 * order is claimed atomically.
 */
export default async function dispatchHeldOrders(container: MedusaContainer) {
  if (!dispatchEnabled()) {
    return
  }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)

  try {
    warnAboutConfig(logger)
    await recoverStalledDispatchesWorkflow(container).run({})
    await recoverMissingDispatches(container)
    await alertUncapturedPayments(container)

    const now = new Date()
    const due = await service.listOrderDispatches(
      { state: "placed", window_ends_at: { $lte: now } },
      { take: BATCH_SIZE, order: { window_ends_at: "ASC" } }
    )
    const retries = await service.listOrderDispatches(
      {
        state: "dispatch_failed",
        attempts: { $lt: MAX_DISPATCH_ATTEMPTS },
        next_attempt_at: { $lte: now },
      },
      { take: BATCH_SIZE, order: { next_attempt_at: "ASC" } }
    )

    for (const row of [...due, ...retries].slice(0, BATCH_SIZE)) {
      try {
        await dispatchOrderWorkflow(container).run({ input: { order_id: row.order_id } })
      } catch (error) {
        logger.error(`[dispatch] order ${row.order_id} could not be dispatched: ${(error as Error).message}`)
      }
    }
  } catch (error) {
    logger.error(`[dispatch] dispatch job failed: ${(error as Error).message}`)
  }
}

let lastConfigWarning = 0

/** Missing settings stop shipping and alerts alike, so the log is the only place left to say so. */
function warnAboutConfig(logger: { error: (message: string) => void }) {
  const problems = dispatchConfigProblems()
  if (problems.length === 0 || Date.now() - lastConfigWarning < 60 * 60 * 1000) {
    return
  }
  lastConfigWarning = Date.now()
  for (const problem of problems) {
    logger.error(`[dispatch] CONFIG: ${problem}`)
  }
}

/** Tells the team once about a prepaid payment Medusa never saw captured. */
async function alertUncapturedPayments(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderService = container.resolve(Modules.ORDER)
  for (const item of await findUncapturedPrepaidOrders(container)) {
    const status = await postToStorefront(
      "/api/ops/notify",
      { type: "payment_not_captured", order_id: item.order_id, order_ref: `EYRA-${item.display_id}` },
      logger
    )
    if (status !== "sent") {
      continue
    }
    await orderService.updateOrders({ id: item.order_id }, { metadata: { capture_alerted: true } })
  }
}

/** Orders whose order-placed handler failed never ship without this. */
async function recoverMissingDispatches(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const window = holdMinutes()
  for (const missing of await findOrdersMissingDispatch(container)) {
    try {
      // The customer keeps the window they were promised, counted from when they ordered.
      const windowEndsAt = new Date(missing.created_at.getTime() + window * 60 * 1000)
      const { result } = await createOrderDispatchWorkflow(container).run({
        input: { order_id: missing.order_id, window_minutes: window, window_ends_at: windowEndsAt.toISOString() },
      })
      if (!result.created) {
        continue
      }
      logger.warn(`[dispatch] order ${missing.order_id} had no dispatch record, created one`)
      await postToStorefront(
        "/api/ops/notify",
        {
          type: "dispatch_recovered",
          order_id: missing.order_id,
          order_ref: `EYRA-${missing.display_id}`,
          cancel_until: windowEndsAt > new Date() ? windowEndsAt.toISOString() : null,
        },
        logger
      )
    } catch (error) {
      logger.error(`[dispatch] could not recover order ${missing.order_id}: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "dispatch-held-orders",
  schedule: "* * * * *",
}
