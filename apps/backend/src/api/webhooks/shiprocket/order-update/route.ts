import { timingSafeEqual } from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { emailOrderDelivered } from "../../../../modules/order-dispatch/customer-emails"
import { processReturnedParcel } from "../../../../modules/order-dispatch/rto"
import { applyShiprocketUpdate } from "../../../../modules/order-dispatch/tracking"
import { postToStorefront } from "../../../../utils/storefront"

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)

/**
 * POST /webhooks/shiprocket/order-update
 *
 * Shiprocket's tracking updates. Sign-in is the shared secret Shiprocket sends in
 * the x-api-key header (SHIPROCKET_WEBHOOK_SECRET); with none set the route is
 * closed rather than open. The storefront's own tracking route forwards the
 * same updates here, so either can be the address Shiprocket calls.
 *
 *  - A delivered forward parcel starts the return window, and the customer is
 *    told it arrived (once).
 *  - A parcel returned to us after a failed or refused delivery gets a credit
 *    note and its refund.
 *  - A reverse pickup we booked that reaches our warehouse is queued for the
 *    quality check, and one that fails alerts the team.
 *
 * Unknown references are acknowledged and ignored, so Shiprocket does not retry
 * them. A failure while doing the follow-up answers 500 so it is retried; each
 * follow-up is safe to repeat.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET
  if (!secret) {
    logger.error("[shiprocket] SHIPROCKET_WEBHOOK_SECRET is not set, rejecting the update")
    return res.status(503).json({ error: "Webhook not configured" })
  }
  const received = req.headers["x-api-key"]
  if (typeof received !== "string" || !safeEqual(received, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" })
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const status = text(body.current_status) ?? text(body.shipment_status)
  const orderRef = text(body.order_id) ?? text(body.channel_order_id)
  const awb = text(body.awb) ?? text(body.awb_code)
  if (!status || (!orderRef && !awb)) {
    return res.status(200).json({ received: true, acted: false, reason: "missing_fields" })
  }

  const stamp = text(body.current_timestamp) ?? text(body.timestamp)
  const parsed = stamp ? new Date(stamp.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? "" : "+05:30")) : null
  const at = parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now() + 60_000 ? parsed : new Date()

  try {
    const outcome = await applyShiprocketUpdate(req.scope, { order_ref: orderRef, awb, status, at })

    for (const step of outcome.followups) {
      if (step === "delivered" && outcome.order_id) {
        await emailOrderDelivered(req.scope, outcome.order_id)
      } else if (step === "rto_delivered" && outcome.order_id) {
        await processReturnedParcel(req.scope, outcome.order_id)
      } else if (step === "reverse_arrived") {
        await postToStorefront(
          "/api/ops/notify",
          { type: "return_parcel_arrived", order_id: outcome.order_id, return_request_id: outcome.return_request_id },
          logger
        )
      } else if (step === "reverse_failed") {
        await postToStorefront(
          "/api/ops/notify",
          { type: "reverse_pickup_problem", order_id: outcome.order_id, return_request_id: outcome.return_request_id, status },
          logger
        )
      }
    }
    return res.status(200).json({ received: true, acted: outcome.matched !== null, matched: outcome.matched })
  } catch (error) {
    logger.error(`[shiprocket] could not apply "${status}" for ${orderRef ?? awb}: ${(error as Error).message}`)
    return res.status(500).json({ error: "Could not apply the update" })
  }
}
