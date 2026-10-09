import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { buildCancellationPreview } from "../../../../../modules/order-dispatch/cancellation-preview"
import { bankRefundEta } from "../../../../../modules/order-dispatch/config"
import { customerCancelOrderWorkflow } from "../../../../../workflows/customer-cancel-order"
import type { CancelOrderBody, CancellationPreviewQuery } from "../../validation"

function orderIdFrom(req: AuthenticatedMedusaRequest<unknown>): string {
  const id = req.params.id
  if (typeof id !== "string" || !id.startsWith("order_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid order id is required")
  }
  return id
}

/**
 * GET /admin/orders/:id/cancellation?customer_id=cus_...
 *
 * What the customer sees before cancelling: whether they can, until when, and
 * what each refund choice gives back. 404 for an order that is not theirs.
 */
export async function GET(req: AuthenticatedMedusaRequest<unknown>, res: MedusaResponse) {
  const orderId = orderIdFrom(req)
  const { customer_id } = req.validatedQuery as unknown as CancellationPreviewQuery

  const preview = await buildCancellationPreview(req.scope, orderId, customer_id)
  if (!preview) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found", "order_not_found")
  }
  return res.json({ preview })
}

/**
 * POST /admin/orders/:id/cancellation
 *
 * The customer cancels their order. Refuses unless the shipment has not been
 * created and the cancel window is open.
 */
export async function POST(req: AuthenticatedMedusaRequest<CancelOrderBody>, res: MedusaResponse) {
  const orderId = orderIdFrom(req)
  const body = req.validatedBody

  const { result } = await customerCancelOrderWorkflow(req.scope).run({
    input: {
      order_id: orderId,
      customer_id: body.customer_id,
      refund_method: body.refund_method,
      reason: body.reason,
      note: body.note,
    },
  })

  return res.json({ cancellation: result, eta: bankRefundEta() })
}
