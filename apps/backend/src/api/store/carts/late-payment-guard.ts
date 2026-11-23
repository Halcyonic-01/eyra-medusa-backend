import type { MedusaNextFunction, MedusaRequest, MedusaResponse, MiddlewareRoute } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { settleLatePayments } from "../../../modules/payment-snapshot/late-payments"

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
  { matcher: "/store/carts/:id/complete", method: ["POST"], middlewares: [settleBeforeComplete] },
]
