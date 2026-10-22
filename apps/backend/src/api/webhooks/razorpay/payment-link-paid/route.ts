import { createHmac, timingSafeEqual } from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../../../../modules/return-request"
import type ReturnRequestModuleService from "../../../../modules/return-request/service"
import { toNumber } from "../../../../modules/wallet/utils"
import { postToStorefront } from "../../../../utils/storefront"
import { bookPickupFor } from "../../../../workflows/steps/start-return-flow"

function signatureValid(rawBody: string, received: string, secret: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "hex")
  const actual = Buffer.from(received, "hex")
  // Buffer.from silently cuts malformed hex short, so the lengths are compared first.
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

type LinkEvent = {
  event?: string
  payload?: {
    payment_link?: { entity?: { id?: string; reference_id?: string; status?: string; amount?: number; amount_paid?: number } }
    payment?: { entity?: { id?: string; amount?: number; status?: string } }
  }
}

/**
 * POST /webhooks/razorpay/payment-link-paid
 *
 * Razorpay tells us a payment link was paid. The signature (HMAC-SHA256 of the
 * raw body with RAZORPAY_WEBHOOK_SECRET) is checked first; with no secret set
 * the route is closed. For an exchange waiting for its price difference, a paid link moves it from pending_fee to
 * reverse_pickup_scheduled and books the courier. A link paid for less than was
 * asked is not accepted. A repeat of the same event does nothing. Anything else is
 * acknowledged and ignored, so Razorpay does not keep retrying it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const secret = process.env.RAZORPAY_TEST_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) {
    logger.error("[razorpay] no webhook secret is set, rejecting the payment link event")
    return res.status(503).json({ error: "Webhook not configured" })
  }
  const received = req.headers["x-razorpay-signature"]
  const raw = (req as MedusaRequest & { rawBody?: Buffer | string }).rawBody
  const rawBody = typeof raw === "string" ? raw : raw ? raw.toString("utf8") : ""
  if (typeof received !== "string" || !rawBody || !signatureValid(rawBody, received, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" })
  }

  const event = (req.body ?? {}) as LinkEvent
  // Razorpay names it payment_link.paid; the spec writes it payment.link.paid. Both are the same event.
  if (event.event !== "payment_link.paid" && event.event !== "payment.link.paid") {
    return res.status(200).json({ received: true, acted: false, reason: "ignored_event" })
  }

  const link = event.payload?.payment_link?.entity
  const paymentId = event.payload?.payment?.entity?.id ?? null
  if (!link?.id) return res.status(200).json({ received: true, acted: false, reason: "missing_link" })

  const service: ReturnRequestModuleService = req.scope.resolve(RETURN_REQUEST_MODULE)
  const [byLink] = await service.listReturnRequests({ fee_link_id: link.id }, { take: 1 })
  const [byReference] = byLink || !link.reference_id ? [undefined] : await service.listReturnRequests({ id: link.reference_id }, { take: 1 })
  const request = byLink ?? byReference
  if (!request || (request.fee_link_id && request.fee_link_id !== link.id)) {
    return res.status(200).json({ received: true, acted: false, reason: "unknown_link" })
  }
  if (request.status !== "pending_fee") {
    return res.status(200).json({ received: true, acted: false, reason: "already_processed" })
  }

  const dueP = Math.round(toNumber(request.amount_due) * 100)
  const paidP = Number(link.amount_paid ?? event.payload?.payment?.entity?.amount ?? 0)
  if (link.status !== "paid" || paidP < dueP) {
    logger.error(`[razorpay] link ${link.id} for ${request.id} was paid ${paidP} paise, ${dueP} was asked`)
    await postToStorefront(
      "/api/ops/notify",
      { type: "exchange_payment_short", return_request_id: request.id, order_id: request.order_id, asked: dueP / 100, paid: paidP / 100 },
      logger
    )
    return res.status(200).json({ received: true, acted: false, reason: "amount_short" })
  }

  try {
    await service.updateReturnRequests({ id: request.id, fee_paid_at: new Date(), fee_payment_id: paymentId })
    const outcome = await bookPickupFor(req.scope, request.id)
    return res.status(200).json({ received: true, acted: true, request_id: request.id, outcome })
  } catch (error) {
    logger.error(`[razorpay] could not move ${request.id} on after its fee was paid: ${(error as Error).message}`)
    // 500 so Razorpay sends it again; the fee is already recorded and booking is safe to repeat.
    return res.status(500).json({ error: "Could not process the payment" })
  }
}
