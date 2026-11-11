import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody } from "../validation-middleware"
import { parseConfirmationEmail, parseDispatchOverride, parseRazorpayConfirmation } from "./validation"

export const orderConfirmationMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/razorpay-confirmations",
    method: "POST",
    middlewares: [validatedBody(parseRazorpayConfirmation)],
  },
  {
    matcher: "/admin/orders/:id/confirmation-email",
    method: "POST",
    middlewares: [validatedBody(parseConfirmationEmail)],
  },
  {
    matcher: "/admin/orders/:id/dispatch-override",
    method: "POST",
    middlewares: [validatedBody(parseDispatchOverride)],
  },
]
