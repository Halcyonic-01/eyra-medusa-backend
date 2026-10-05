import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody, validatedQuery } from "../validation-middleware"
import {
  parseApplyWalletToCart,
  parseGetWallets,
  parseIssueWalletCredit,
} from "./validation"

export const walletMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/wallets",
    method: "GET",
    middlewares: [validatedQuery(parseGetWallets)],
  },
  {
    matcher: "/admin/wallets/credits",
    method: "POST",
    middlewares: [validatedBody(parseIssueWalletCredit)],
  },
  {
    matcher: "/admin/wallets/cart",
    method: "POST",
    middlewares: [validatedBody(parseApplyWalletToCart)],
  },
]
