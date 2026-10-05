import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody, validatedQuery } from "../validation-middleware"
import {
  parseApproveReturnRequest,
  parseCreateReturnRequest,
  parseListReturnRequests,
  parseRejectReturnRequest,
} from "./validation"

export const returnRequestMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/return-requests",
    method: "GET",
    middlewares: [validatedQuery(parseListReturnRequests)],
  },
  {
    matcher: "/admin/return-requests",
    method: "POST",
    middlewares: [validatedBody(parseCreateReturnRequest)],
  },
  {
    matcher: "/admin/return-requests/:id/approve",
    method: "POST",
    middlewares: [validatedBody(parseApproveReturnRequest)],
  },
  {
    matcher: "/admin/return-requests/:id/reject",
    method: "POST",
    middlewares: [validatedBody(parseRejectReturnRequest)],
  },
]
