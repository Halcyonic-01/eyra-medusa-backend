import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../../../modules/return-request"
import { exchangePaymentDue } from "../../../modules/return-request/constants"
import { fromStoredItems } from "../../../modules/return-request/items"
import type ReturnRequestModuleService from "../../../modules/return-request/service"
import { toNumber } from "../../../modules/wallet/utils"
import { createReturnRequestWorkflow } from "../../../workflows/create-return-request"
import type { CreateReturnRequestBody, ListReturnRequestsQuery } from "./validation"

type CustomerRow = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

type OrderRow = {
  id: string
  display_id: number
  total: unknown
}

/**
 * GET /admin/return-requests
 *
 * Requests newest first, filterable by customer, order and status. Each comes
 * with the customer and the order number, so staff can read the list as is.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const requestService: ReturnRequestModuleService = req.scope.resolve(RETURN_REQUEST_MODULE)
  const { customer_id, order_id, status, limit, offset } = req.validatedQuery as ListReturnRequestsQuery

  const filters: Record<string, unknown> = {}
  if (customer_id) filters.customer_id = customer_id
  if (order_id) filters.order_id = order_id
  if (status) filters.status = status

  const [requests, count] = await requestService.listAndCountReturnRequests(filters, {
    take: limit,
    skip: offset,
    order: { created_at: "DESC" },
  })

  const customerIds = [...new Set(requests.map((request) => request.customer_id))]
  const orderIds = [...new Set(requests.map((request) => request.order_id))]

  const customers = customerIds.length
    ? ((await query.graph({
        entity: "customer",
        fields: ["id", "email", "first_name", "last_name"],
        filters: { id: customerIds },
      })).data as CustomerRow[])
    : []
  const orders = orderIds.length
    ? ((await query.graph({
        entity: "order",
        fields: ["id", "display_id", "total"],
        filters: { id: orderIds },
      })).data as unknown as OrderRow[])
    : []

  return res.json({
    return_requests: requests.map((request) => {
      const customer = customers.find((row) => row.id === request.customer_id)
      const order = orders.find((row) => row.id === request.order_id)
      const items = fromStoredItems(request.items)
      return {
        id: request.id,
        order_id: request.order_id,
        order_display_id: order?.display_id ?? null,
        customer_id: request.customer_id,
        customer: customer
          ? { email: customer.email, first_name: customer.first_name, last_name: customer.last_name }
          : null,
        type: request.type,
        reason: request.reason,
        note: request.note,
        items,
        items_total: toNumber(items.reduce((sum, item) => sum + item.total, 0)),
        status: request.status,
        credit_amount: request.credit_amount === null ? null : toNumber(request.credit_amount),
        resolution_note: request.resolution_note,
        resolved_at: request.resolved_at,
        created_at: request.created_at,
        delivered_at: request.delivered_at,
        paid_value: request.paid_value === null ? null : toNumber(request.paid_value),
        fee_amount: request.fee_amount === null ? null : toNumber(request.fee_amount),
        reverse: {
          order_ref: request.reverse_order_ref,
          awb: request.reverse_awb,
          error: request.reverse_error,
        },
        exchange:
          request.type === "exchange"
            ? {
                replacement_title: request.replacement_title,
                replacement_price: request.replacement_price === null ? null : toNumber(request.replacement_price),
                price_difference: request.price_difference === null ? null : toNumber(request.price_difference),
                amount_due: request.amount_due === null ? null : toNumber(request.amount_due),
                fee_link_url: request.fee_link_url,
                fee_paid_at: request.fee_paid_at,
                payment_required: exchangePaymentDue(toNumber(request.amount_due)),
                replacement_order_id: request.replacement_order_id,
              }
            : null,
        credit_note_id: request.credit_note_id,
        received_at: request.received_at,
      }
    }),
    count,
    limit,
    offset,
  })
}

/**
 * POST /admin/return-requests
 *
 * Records a return or exchange request. Called by the storefront server on
 * behalf of the signed-in customer.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<CreateReturnRequestBody>,
  res: MedusaResponse
) {
  const { result } = await createReturnRequestWorkflow(req.scope).run({
    input: req.validatedBody,
  })

  return res.status(201).json({ return_request: result })
}
