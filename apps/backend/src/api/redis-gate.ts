import type { MedusaNextFunction, MedusaRequest, MedusaResponse, MiddlewareRoute } from "@medusajs/framework/http"
import { redisHealth } from "../utils/redis-health"

/**
 * Answers 503 at once, instead of hanging, when Redis is down. Only on routes
 * that need Redis to do their work (they run workflows or queue events) and
 * whose callers retry: Razorpay webhooks, cart completion, opening a payment,
 * checkout pricing, and the storefront's confirmation calls.
 */
export async function requireRedis(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const health = redisHealth(req.scope)
  if (!health) return next()
  // Known down: refuse at once. Otherwise ask Redis now (about a millisecond when
  // healthy, at most the one-second timeout when not), so a request arriving in
  // the first seconds of an outage does not slip through and hang.
  const state = health.state === "down" ? "down" : await health.check()
  if (state === "down") {
    res.setHeader("Retry-After", "30")
    return res.status(503).json({ message: "Temporarily unavailable, please try again shortly", type: "redis_unavailable" })
  }
  next()
}

const gated = [
  "/hooks/payment/:provider",
  "/store/carts/:id/complete",
  "/store/carts/:id/razorpay-session",
  "/store/carts/:id/payment-mode",
  "/admin/razorpay-confirmations",
  "/admin/orders/:id/confirmation-email",
]

export const redisGateMiddlewares: MiddlewareRoute[] = gated.map((matcher) => ({
  matcher,
  method: "POST",
  middlewares: [requireRedis],
}))
