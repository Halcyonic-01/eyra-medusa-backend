import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { loadReviewOrder } from "../../../../workflows/steps/review-orders"
import { buildSession } from "../../../../workflows/steps/review-session"
import { submitProductReviewsWorkflow } from "../../../../workflows/submit-product-reviews"
import type { CustomerOrderQuery, CustomerReviewsBody } from "../../../review-validation"

/**
 * The signed-in customer's own reviews of an order. Called by the storefront,
 * which has checked who the customer is (Clerk) and passes their Medusa id; the
 * order must be theirs.
 *
 * GET  /admin/product-reviews/customer?customer_id=&order_id=   the order's products and their reviews
 * POST /admin/product-reviews/customer { customer_id, order_id, reviews }   add or edit reviews
 */
export async function GET(req: AuthenticatedMedusaRequest<unknown, CustomerOrderQuery>, res: MedusaResponse) {
  const { customer_id, order_id } = req.validatedQuery as unknown as CustomerOrderQuery
  const order = await loadReviewOrder(req.scope, order_id)
  if (!order || order.customer_id !== customer_id) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found.")
  return res.json({ session: await buildSession(req.scope, order, "ok", null) })
}

export async function POST(req: AuthenticatedMedusaRequest<CustomerReviewsBody>, res: MedusaResponse) {
  const { customer_id, order_id, reviews } = req.validatedBody
  const { result } = await submitProductReviewsWorkflow(req.scope).run({
    input: { reviewer: { source: "account", customer_id, order_id }, reviews },
  })
  return res.status(201).json({ reviews: result.reviews, status: "pending" })
}
