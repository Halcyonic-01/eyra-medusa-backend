import { createHmac, timingSafeEqual } from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../../../../modules/return-request"
import type ReturnRequestModuleService from "../../../../modules/return-request/service"
import { settleExchangePayment } from "../../../../modules/return-request/exchange-payment"

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

/** Razorpay names it payment_link.paid; the spec writes it payment.link.paid. Both are the same event. */
const PAID = ["payment_link.paid", "payment.link.paid"]
const CLOSED = ["payment_link.expired", "payment_link.cancelled", "payment.link.expired", "payment.link.cancelled"]

/**
 * POST /webhooks/razorpay/payment-link-paid
 *
 * Razorpay tells us about an exchange's payment link. The signature (HMAC-SHA256
 * of the raw body with RAZORPAY_WEBHOOK_SECRET) is checked first; with no secret
 * set the route is closed. What happens next is `settleExchangePayment`'s: a link
 * paid in full moves the exchange on and books the courier, a link paid after the
 * exchange was closed is refunded, an expired or cancelled link closes the
 * exchange, and a link paid for less than was asked is not accepted. A repeat of
 * the same event does nothing. Anything else is acknowledged and ignored, so
 * Razorpay does not keep retrying it.
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
  const isPaid = PAID.includes(event.event ?? "")
  if (!isPaid && !CLOSED.includes(event.event ?? "")) {
    return res.status(200).json({ received: true, acted: false, reason: "ignored_event" })
  }

  const link = event.payload?.payment_link?.entity
  if (!link?.id) return res.status(200).json({ received: true, acted: false, reason: "missing_link" })

  const service: ReturnRequestModuleService = req.scope.resolve(RETURN_REQUEST_MODULE)
  const [byLink] = await service.listReturnRequests({ fee_link_id: link.id }, { take: 1 })
  const [byReference] = byLink || !link.reference_id ? [undefined] : await service.listReturnRequests({ id: link.reference_id }, { take: 1 })
  const request = byLink ?? byReference
  if (!request || request.fee_link_id !== link.id) {
    return res.status(200).json({ received: true, acted: false, reason: "unknown_link" })
  }

  try {
    const result = await settleExchangePayment(req.scope, request.id, {
      link_id: link.id,
      // A paid event whose link is not marked paid (a partial payment) is treated as unpaid.
      status: isPaid ? (link.status ?? "paid") : (link.status ?? event.event!.split(".").pop()!),
      paid_paise: Number(link.amount_paid ?? event.payload?.payment?.entity?.amount ?? 0),
      payment_id: event.payload?.payment?.entity?.id ?? null,
    })
    if (result.acted) return res.status(200).json({ received: true, acted: true, request_id: request.id, outcome: result.outcome })
    // A paid event for a link that is not paid in full is a short payment.
    if (isPaid && result.reason === "waiting") {
      return res.status(200).json({ received: true, acted: false, reason: "amount_short" })
    }
    return res.status(200).json({ received: true, acted: false, reason: result.reason })
  } catch (error) {
    logger.error(`[razorpay] could not act on the link event for ${request.id}: ${(error as Error).message}`)
    // 500 so Razorpay sends it again; everything it starts is safe to repeat.
    return res.status(500).json({ error: "Could not process the payment" })
  }
}
