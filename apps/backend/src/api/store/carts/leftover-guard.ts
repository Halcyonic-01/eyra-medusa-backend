import type { MedusaNextFunction, MedusaRequest, MedusaResponse, MiddlewareRoute } from "@medusajs/framework/http"
import { clearCartLeftovers } from "../../../workflows/steps/void-orphan-order"

/**
 * Before any change to a cart: void leftovers a crashed completion of that cart
 * left behind (see void-orphan-order), so a discount code the leftover used up
 * is given back before Medusa recomputes the cart's codes. Cheap when there are
 * none, which is almost always. Never blocks the request.
 */
export async function clearLeftoversFirst(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  const cartId = req.params?.id ?? req.path.split("/").filter(Boolean)[2]
  if (typeof cartId === "string" && cartId.startsWith("cart_")) {
    await clearCartLeftovers(req.scope, cartId).catch(() => undefined)
  }
  next()
}

export const cartLeftoverMiddlewares: MiddlewareRoute[] = [
  { matcher: "/store/carts/:id", method: ["POST"], middlewares: [clearLeftoversFirst] },
  { matcher: "/store/carts/:id/*", method: ["POST", "DELETE"], middlewares: [clearLeftoversFirst] },
]
