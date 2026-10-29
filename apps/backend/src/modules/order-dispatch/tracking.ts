import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../return-request"
import type ReturnRequestModuleService from "../return-request/service"
import { ORDER_DISPATCH_MODULE } from "./index"
import type OrderDispatchModuleService from "./service"
import { classifyStatus, normaliseStatus, type StatusKind } from "./shiprocket-status"

/** A repeat of a delivery notice is acted on only while it is this recent. */
const FRESH_NEWS_MS = 3 * 24 * 60 * 60 * 1000

export type ShiprocketUpdate = {
  /** The reference the order is known by at Shiprocket, for example EYRA-21 or EYRA-21-R1. */
  order_ref: string | null
  awb: string | null
  status: string
  /** When the courier reported it, or when we heard. */
  at: Date
}

export type TrackingOutcome = {
  matched: "forward" | "reverse" | null
  kind: StatusKind
  order_id: string | null
  return_request_id: string | null
  /** What the caller should do next, in order. */
  followups: ("rto_delivered" | "reverse_arrived" | "reverse_failed" | "delivered")[]
}

/**
 * Applies one Shiprocket status update. It finds what the update is about (the
 * order's own shipment, or a reverse pickup we booked for a return or exchange),
 * records it, and says what must happen next. It never moves money itself: the
 * follow-ups (the credit note and refund for a returned parcel, the inspection
 * queue for a reverse parcel) are done by the caller, so a repeat of the same
 * update is harmless.
 */
export async function applyShiprocketUpdate(
  container: MedusaContainer,
  update: ShiprocketUpdate
): Promise<TrackingOutcome> {
  const kind = classifyStatus(update.status)
  const status = normaliseStatus(update.status)
  const none: TrackingOutcome = { matched: null, kind, order_id: null, return_request_id: null, followups: [] }

  const returns: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  const dispatches: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)

  // A reverse pickup we booked has its own reference and AWB, so check those first.
  const reverseFilters = [
    ...(update.order_ref ? [{ reverse_order_ref: update.order_ref }] : []),
    ...(update.awb ? [{ reverse_awb: update.awb }] : []),
  ]
  for (const filter of reverseFilters) {
    const [request] = await returns.listReturnRequests(filter, { take: 1 })
    if (!request) continue

    const followups: TrackingOutcome["followups"] = []
    if (kind === "delivered" && ["pending", "reverse_pickup_scheduled"].includes(request.status)) {
      await returns.updateReturnRequests({ id: request.id, status: "awaiting_inspection", reverse_error: null })
      followups.push("reverse_arrived")
    } else if (kind === "failed" && ["pending", "reverse_pickup_scheduled"].includes(request.status)) {
      await returns.updateReturnRequests({
        id: request.id,
        status: "pending",
        reverse_error: `The courier reported "${status}" for the pickup`.slice(0, 300),
      })
      followups.push("reverse_failed")
    }
    return { matched: "reverse", kind, order_id: request.order_id, return_request_id: request.id, followups }
  }

  const forwardFilters = [
    ...(update.order_ref ? [{ shiprocket_order_ref: update.order_ref }] : []),
    ...(update.awb ? [{ awb_code: update.awb }] : []),
  ]
  for (const filter of forwardFilters) {
    const [dispatch] = await dispatches.listOrderDispatches(filter, { take: 1 })
    if (!dispatch) continue

    const patch: Record<string, unknown> = { id: dispatch.id, shiprocket_status: status, shiprocket_status_at: update.at }
    const followups: TrackingOutcome["followups"] = []

    // Each moment is recorded once, the first time it is heard.
    if ((kind === "attempted" || kind === "delivered" || kind === "rto") && !dispatch.delivery_attempted_at) {
      patch.delivery_attempted_at = update.at
    }
    if (kind === "delivered") {
      // The customer email is sent once however often this runs, so a repeat of
      // fresh news lets one that failed go out. Old news is never acted on.
      if (!dispatch.delivered_at || Date.now() - update.at.getTime() < FRESH_NEWS_MS) {
        followups.push("delivered")
      }
      if (!dispatch.delivered_at) patch.delivered_at = update.at
    }
    if ((kind === "rto" || kind === "rto_delivered") && !dispatch.rto_initiated_at) patch.rto_initiated_at = update.at
    if (kind === "rto_delivered" && !dispatch.rto_delivered_at) {
      patch.rto_delivered_at = update.at
      followups.push("rto_delivered")
    }
    await dispatches.updateOrderDispatches(patch as never)

    // The storefront reads these keys to decide whether a return is still allowed.
    // Only these keys are sent: the order module merges them into the rest.
    await container.resolve(Modules.ORDER).updateOrders(
      { id: dispatch.order_id },
      {
        metadata: {
          shiprocket_status: status,
          shiprocket_status_updated_at: update.at.toISOString(),
          ...(update.awb ? { awb_code: update.awb } : {}),
        },
      }
    )
    return { matched: "forward", kind, order_id: dispatch.order_id, return_request_id: null, followups }
  }

  return none
}
