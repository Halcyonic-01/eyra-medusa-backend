import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import {
  invoicePrefix,
  MAX_DISPATCH_ATTEMPTS,
  retryDelayMinutes,
} from "../../modules/order-dispatch/config"
import {
  markCancelled,
  markCancelledWithShipment,
  markDispatchFailed,
  markShipped,
  toSnapshot,
  type DispatchSnapshot,
  type Pg,
} from "../../modules/order-dispatch/transitions"
import { postToStorefront } from "../../utils/storefront"
import type { ShipmentPlan } from "./build-shipment-request"
import type { ShipmentOutcome } from "./request-shipment"

type Input = {
  order_id: string
  /** Attempts used so far, counting this one. */
  attempts: number
  plan: ShipmentPlan
  outcome: ShipmentOutcome
}

export type DispatchFinish = {
  /** "unchanged" means another process had already moved the order on. */
  state: "shipped" | "dispatch_failed" | "cancelled" | "unchanged"
  dispatch: DispatchSnapshot | null
  error: string | null
}

/**
 * Records how dispatching ended. Success marks the order shipped and issues its
 * tax invoice number; a failure schedules a retry and tells staff the first
 * time and when the retries run out.
 */
export const finishDispatchStep = createStep("finish-dispatch", async (input: Input, { container }) => {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  const { order_id: orderId, outcome } = input

  if (outcome.ok) {
    // An order cancelled while its shipment was being made gets no invoice.
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "status", "canceled_at"],
      filters: { id: orderId },
    })
    const current = orders[0] as { status?: string; canceled_at?: unknown } | undefined
    if (current && (current.status === "canceled" || current.canceled_at)) {
      const closed = await markCancelledWithShipment(pg, orderId, outcome.shipment)
      if (closed) {
        await postToStorefront(
          "/api/ops/notify",
          {
            type: "shipment_orphaned",
            order_id: orderId,
            order_ref: outcome.shipment.shiprocket_order_ref,
            state: "cancelled",
            shipment_id: outcome.shipment.shiprocket_shipment_id,
            awb_code: outcome.shipment.awb_code,
          },
          logger
        )
        const result: DispatchFinish = { state: "cancelled", dispatch: toSnapshot(closed), error: null }
        return new StepResponse(result)
      }
    }

    const row = await markShipped(pg, orderId, outcome.shipment, invoicePrefix())
    if (!row) {
      // A shipment now exists for an order that moved on meanwhile (cancelled,
      // or taken over by a retry), so it may be unwanted or a duplicate.
      const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
      const [current] = await service.listOrderDispatches({ order_id: orderId }, { take: 1 })
      logger.error(
        `[dispatch] order ${orderId}: shipment ${outcome.shipment.shiprocket_shipment_id} was created but the order is ${current?.state ?? "missing"}`
      )
      await postToStorefront(
        "/api/ops/notify",
        {
          type: "shipment_orphaned",
          order_id: orderId,
          order_ref: outcome.shipment.shiprocket_order_ref,
          state: current?.state ?? null,
          shipment_id: outcome.shipment.shiprocket_shipment_id,
          awb_code: outcome.shipment.awb_code,
        },
        logger
      )
      const result: DispatchFinish = { state: "unchanged", dispatch: null, error: null }
      return new StepResponse(result)
    }
    logger.info(
      `[dispatch] order ${orderId} shipped, invoice ${row.invoice_number}, AWB ${row.awb_code ?? "none"}`
    )
    const result: DispatchFinish = { state: "shipped", dispatch: toSnapshot(row), error: null }
    return new StepResponse(result)
  }

  if (outcome.canceled) {
    const row = await markCancelled(pg, orderId, ["dispatching"])
    logger.info(`[dispatch] order ${orderId} was cancelled before shipping, nothing was created`)
    const result: DispatchFinish = {
      state: row ? "cancelled" : "unchanged",
      dispatch: row ? toSnapshot(row) : null,
      error: null,
    }
    return new StepResponse(result)
  }

  const row = await markDispatchFailed(pg, orderId, outcome.error, retryDelayMinutes(input.attempts))
  logger.error(
    `[dispatch] order ${orderId} attempt ${input.attempts} failed: ${outcome.error}`
  )

  const giveUp = input.attempts >= MAX_DISPATCH_ATTEMPTS
  if (row && (input.attempts === 1 || giveUp)) {
    await postToStorefront(
      "/api/ops/notify",
      {
        type: "dispatch_failed",
        order_id: orderId,
        order_ref: input.plan.action === "ship" ? input.plan.request.eyraOrderRef : null,
        attempts: input.attempts,
        max_attempts: MAX_DISPATCH_ATTEMPTS,
        will_retry: !giveUp,
        error: outcome.error,
      },
      logger
    )
  }

  const result: DispatchFinish = {
    state: row ? "dispatch_failed" : "unchanged",
    dispatch: row ? toSnapshot(row) : null,
    error: outcome.error,
  }
  return new StepResponse(result)
})
