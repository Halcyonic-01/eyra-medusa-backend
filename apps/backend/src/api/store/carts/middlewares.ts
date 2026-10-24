import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody } from "../../admin/validation-middleware"
import { parseDiscountCode, parsePaymentMode } from "./validation"

export const storeCartMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/store/carts/:id/payment-mode",
    method: "POST",
    middlewares: [validatedBody(parsePaymentMode)],
  },
  {
    matcher: "/store/carts/:id/discount-code",
    method: "POST",
    middlewares: [validatedBody(parseDiscountCode)],
  },
]
