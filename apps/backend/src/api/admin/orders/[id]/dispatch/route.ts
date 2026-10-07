import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { dispatchConfigProblems } from "../../../../../modules/order-dispatch/config"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { ORDER_DISPATCH_MODULE } from "../../../../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../../../../modules/order-dispatch/service"
import {
  toSnapshot,
  type DispatchRow,
} from "../../../../../modules/order-dispatch/transitions"
import { loadCancellationSummary } from "../../../../../modules/order-dispatch/cancellation-preview"
import { createOrderDispatchWorkflow } from "../../../../../workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../../../../../workflows/dispatch-order"

function orderIdFrom(req: AuthenticatedMedusaRequest): string {
  const id = req.params.id
  if (typeof id !== "string" || !id.startsWith("order_")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "A valid order id is required")
  }
  return id
}

/**
 * GET /admin/orders/:id/dispatch
 *
 * Where the order is on its way to the courier: the cancel window, the
 * shipment, and the tax invoice. `dispatch` is null for an order placed before
 * this existed.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const orderId = orderIdFrom(req)
  const service: OrderDispatchModuleService = req.scope.resolve(ORDER_DISPATCH_MODULE)
  const [row] = await service.listOrderDispatches({ order_id: orderId }, { take: 1 })

  const cancellation = await loadCancellationSummary(req.scope, orderId)

  return res.json({
    dispatch: row ? toSnapshot(row as unknown as DispatchRow) : null,
    cancellation,
    config_problems: dispatchConfigProblems(),
  })
}

/**
 * POST /admin/orders/:id/dispatch
 *
 * "Ship now": creates the courier shipment immediately, closing the customer's
 * cancel window. Also retries an order whose earlier attempts failed.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const orderId = orderIdFrom(req)
  const service: OrderDispatchModuleService = req.scope.resolve(ORDER_DISPATCH_MODULE)

  const [existing] = await service.listOrderDispatches({ order_id: orderId }, { take: 1 })
  if (!existing) {
    // An order placed before dispatch was tracked. If the old flow already
    // shipped it there is nothing to do, and it must not be given an invoice
    // number it never needed.
    const orderService = req.scope.resolve(Modules.ORDER)
    const [order] = await orderService.listOrders({ id: orderId }, { select: ["id", "metadata"] })
    if (!order) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
    }
    const meta = order.metadata ?? {}
    // A shipment half-made by the old flow can still be finished from here.
    if (meta.shiprocket_shipment_id && meta.awb_code && meta.shipping_label_url) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This order already has a shipment from before dispatch was tracked"
      )
    }
    await createOrderDispatchWorkflow(req.scope).run({
      input: { order_id: orderId, window_minutes: 0 },
    })
  }

  const { result } = await dispatchOrderWorkflow(req.scope).run({
    input: { order_id: orderId, force: true },
  })

  return res.json(result)
}
