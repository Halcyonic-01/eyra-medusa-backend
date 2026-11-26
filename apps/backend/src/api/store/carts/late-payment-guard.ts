import type { MedusaNextFunction, MedusaRequest, MedusaResponse, MiddlewareRoute } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { loadCartPaymentState } from "../../../modules/payment-snapshot/check"
import { GatewayUnavailableError, getGateway, isPrepaidProvider } from "../../../modules/payment-snapshot/gateways"
import { paidAttempts, settleLatePayments } from "../../../modules/payment-snapshot/late-payments"

/**
 * Before a cart completes without an online payment (Cash on Delivery): refuse
 * while an online payment on the same cart is still in progress at a provider,
 * or cannot be checked. Completing then would leave a payment that may still
 * go through. The storefront checks this too; this covers direct calls to this
 * public route and a second tab. A payment already taken is left to the settle.
 */
export async function refuseOfflineWhilePending(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const cartId = req.params?.id
  if (typeof cartId !== "string" || !cartId.startsWith("cart_")) return next()
  const state = await loadCartPaymentState(req.scope, cartId)
  const session = state?.session
  if (!state || state.cart.completed_at || !session || isPrepaidProvider(session.provider_id)) return next()
  try {
    const paid = await paidAttempts(req.scope, cartId, state.prepaidSessions)
    if (paid.pending.length && !paid.current && !paid.replaced) {
      const name = getGateway(paid.pending[0].provider_id)?.name ?? "your online payment"
      return res.status(400).json({
        type: "not_allowed",
        message: `Your payment with ${name} is still being confirmed. Please wait for it before choosing another way to pay.`,
      })
    }
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error
    return res.status(400).json({
      type: "not_allowed",
      message: "We couldn't check an earlier online payment for this cart. Please try again in a minute.",
    })
  }
  next()
}

/**
 * Before a cart completes: if the customer paid an older Razorpay attempt that
 * a newer one replaced, put that payment back on the cart (or refund it), so
 * the browser's verify and the storefront webhook complete with the money that
 * was actually taken. Cheap when the cart has one attempt. Never blocks the
 * completion; the late-payment job retries anything left.
 */
export async function settleBeforeComplete(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  const cartId = req.params?.id
  if (typeof cartId === "string" && cartId.startsWith("cart_")) {
    await settleLatePayments(req.scope, cartId, { complete: false }).catch((error: Error) => {
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).error(`[late-payment] settle before completing ${cartId} failed: ${error.message}`)
    })
  }
  next()
}

export const latePaymentMiddlewares: MiddlewareRoute[] = [
  { matcher: "/store/carts/:id/complete", method: ["POST"], middlewares: [refuseOfflineWhilePending, settleBeforeComplete] },
]
