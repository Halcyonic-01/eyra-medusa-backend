import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody, validatedQuery } from "../validation-middleware"
import { parseCancelOrder, parseCancellationPreview } from "./validation"

export const orderCancellationMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/orders/:id/cancellation",
    method: "GET",
    middlewares: [validatedQuery(parseCancellationPreview)],
  },
  {
    matcher: "/admin/orders/:id/cancellation",
    method: "POST",
    middlewares: [validatedBody(parseCancelOrder)],
  },
]
