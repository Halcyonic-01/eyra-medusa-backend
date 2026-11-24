import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
  MiddlewareRoute,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  razorpayWebhookSecret,
  webhookSignatureValid,
  webhookTarget,
  withSessionId,
} from "../../modules/payment-snapshot/webhook-guard"
import { findAttempt } from "../../modules/payment-snapshot/attempts"
import { requestSettle } from "../../modules/payment-snapshot/late-payments"
import { PAYU_PROVIDER_ID } from "../../modules/payu-payment/attempt"
import { payuConfig } from "../../modules/payu-payment/config"
import { responseHashValid, type PayuResponse } from "../../modules/payu-payment/hash"
import { resolveWebhookSessionWorkflow } from "../../workflows/resolve-webhook-session"

const RAZORPAY_HOOK = "razorpay_razorpay"
const PAYU_HOOK = "payu_payu"

/**
 * Guards Medusa's own payment webhooks. Only Razorpay's and PayU's are
 * accepted (PayU's: see guardPayuWebhook). Razorpay's only
 * once its signature checks out and the backend knows which payment session it
 * is for; that session id then replaces whatever the browser put in the notes.
 * Anything else is answered without reaching Medusa's payment workflow, which
 * would otherwise run with no session and act on unrelated payments and carts.
 * The plugin still checks the signature itself afterwards.
 */
export async function guardPaymentWebhook(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const provider = req.path.split("/").filter(Boolean)[2] ?? ""
  if (provider === PAYU_HOOK) return guardPayuWebhook(req, res, next)
  if (provider !== RAZORPAY_HOOK) {
    return res.status(404).json({ message: "Unknown payment webhook" })
  }

  const secret = razorpayWebhookSecret()
  if (!secret) {
    logger.error("[razorpay-hook] no webhook secret configured, refusing the webhook")
    return res.status(503).json({ message: "Webhook not configured" })
  }
  if (!webhookSignatureValid((req as { rawBody?: Buffer }).rawBody, req.headers["x-razorpay-signature"], secret)) {
    logger.warn("[razorpay-hook] rejected a webhook with a bad or missing signature")
    return res.status(400).json({ message: "Invalid signature" })
  }

  const target = webhookTarget(req.body)
  if (!target) {
    return res.status(200).json({ received: true, acted: false })
  }

  const { result } = await resolveWebhookSessionWorkflow(req.scope).run({
    input: { razorpay_order_id: target.razorpay_order_id },
  })
  if (result.session_id === null) {
    if (result.reason !== "no_snapshot") {
      // A replaced attempt was paid: the settle recovers it into the order or refunds it.
      logger.warn(
        `[razorpay-hook] ${target.event} for Razorpay order ${target.razorpay_order_id} is on a replaced attempt of cart ${result.cart_id}; settling it`
      )
      await requestSettle(req.scope, result.cart_id)
      return res.status(200).json({ received: true, acted: false, reason: result.reason, settling: true })
    }
    logger.warn(
      `[razorpay-hook] ${target.event} for Razorpay order ${target.razorpay_order_id} matches no payment session (${result.reason}); not processed here. The storefront webhook still completes known carts.`
    )
    return res.status(200).json({ received: true, acted: false, reason: result.reason })
  }

  withSessionId(req.body, result.session_id)
  next()
}

/**
 * PayU's webhook (form fields, as on its return to surl/furl). Accepted only
 * with a valid PayU hash for our merchant key and for a transaction the
 * backend itself recorded; the backend's own session id is then attached
 * (eyra_session_id) and the PayU provider asks PayU what happened before
 * Medusa acts. A paid replaced attempt goes to the late-payment settle.
 */
export async function guardPayuWebhook(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const config = payuConfig()
  if (!config) {
    logger.error("[payu-hook] PayU is not configured, refusing the webhook")
    return res.status(503).json({ message: "Webhook not configured" })
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as PayuResponse & Record<string, unknown>
  // Only PayU may say which session: anything a caller put here is dropped first.
  delete body.eyra_session_id
  if (!body.txnid || !responseHashValid(body, config.key, config.salt)) {
    logger.warn("[payu-hook] rejected a webhook with a bad or missing hash")
    return res.status(400).json({ message: "Invalid hash" })
  }

  const attempt = await findAttempt(req.scope, PAYU_PROVIDER_ID, body.txnid)
  if (!attempt.found) {
    logger.warn(`[payu-hook] PayU transaction ${body.txnid} is not one of ours; not processed`)
    return res.status(200).json({ received: true, acted: false, reason: "no_snapshot" })
  }
  if (!attempt.session_id) {
    logger.warn(`[payu-hook] PayU transaction ${body.txnid} is on a replaced attempt of cart ${attempt.cart_id}; settling it`)
    await requestSettle(req.scope, attempt.cart_id)
    return res.status(200).json({ received: true, acted: false, reason: attempt.reason, settling: true })
  }
  body.eyra_session_id = attempt.session_id
  next()
}

export const paymentHookMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/hooks/payment/:provider",
    method: "POST",
    middlewares: [guardPaymentWebhook],
  },
]
