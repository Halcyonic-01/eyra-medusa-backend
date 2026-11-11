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
import { resolveWebhookSessionWorkflow } from "../../workflows/resolve-webhook-session"

const RAZORPAY_HOOK = "razorpay_razorpay"

/**
 * Guards Medusa's own payment webhooks. Only Razorpay's is accepted, and only
 * once its signature checks out and the backend knows which payment session it
 * is for; that session id then replaces whatever the browser put in the notes.
 * Anything else is answered without reaching Medusa's payment workflow, which
 * would otherwise run with no session and act on unrelated payments and carts.
 * The plugin still checks the signature itself afterwards.
 */
export async function guardPaymentWebhook(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const provider = req.path.split("/").filter(Boolean)[2] ?? ""
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
    logger.warn(
      `[razorpay-hook] ${target.event} for Razorpay order ${target.razorpay_order_id} matches no payment session (${result.reason}); not processed here. The storefront webhook still completes known carts.`
    )
    return res.status(200).json({ received: true, acted: false, reason: result.reason })
  }

  withSessionId(req.body, result.session_id)
  next()
}

export const paymentHookMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/hooks/payment/:provider",
    method: "POST",
    middlewares: [guardPaymentWebhook],
  },
]
