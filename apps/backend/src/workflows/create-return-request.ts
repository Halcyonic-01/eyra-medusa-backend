import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { useQueryGraphStep } from "@medusajs/medusa/core-flows"
import type { ReturnRequestReason } from "../modules/return-request/constants"
import { createReturnRequestStep, type ReturnRequestType } from "./steps/create-return-request"
import { startReturnFlowStep } from "./steps/start-return-flow"
import { validateReturnRequestStep } from "./steps/validate-return-request"

export type CreateReturnRequestInput = {
  customer_id: string
  order_id: string
  type: ReturnRequestType
  reason: ReturnRequestReason
  note?: string
  /** An exchange: the variant wanted instead. */
  replacement_variant_id?: string
  items: { item_id: string; quantity: number }[]
}

/**
 * Records a customer's request to return or exchange items from a delivered
 * order, after checking it is theirs, inside the 7 days after delivery, and
 * valid; then sets it going: a return books the courier, an exchange asks for
 * the handling fee with a payment link. An exchange whose link cannot be made is
 * not kept, so the customer is never left waiting on a link that does not exist.
 */
export const createReturnRequestWorkflow = createWorkflow(
  "create-return-request",
  function (input: CreateReturnRequestInput) {
    const { data: orders } = useQueryGraphStep({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "customer_id",
        "email",
        "status",
        "discount_total",
        "metadata",
        "items.id",
        "items.title",
        "items.variant_title",
        "items.variant_sku",
        "items.quantity",
        "items.detail.quantity",
        "items.unit_price",
      ],
      filters: { id: input.order_id },
    })

    const { data: customers } = useQueryGraphStep({
      entity: "customer",
      fields: ["id", "email"],
      filters: { id: input.customer_id },
    }).config({ name: "find-customer" })

    const validated = validateReturnRequestStep(
      transform({ input, orders, customers }, (data) => ({
        customer_id: data.input.customer_id,
        order_id: data.input.order_id,
        type: data.input.type,
        reason: data.input.reason,
        replacement_variant_id: data.input.replacement_variant_id,
        items: data.input.items,
        orders: data.orders,
        customers: data.customers,
      }))
    )

    const request = createReturnRequestStep(
      transform({ input, validated }, (data) => ({
        order_id: data.input.order_id,
        customer_id: data.input.customer_id,
        type: data.input.type,
        reason: data.input.reason,
        note: data.input.note ?? null,
        items: data.validated.items,
        paid_value: data.validated.paid_value,
        fee_amount: data.validated.fee_amount,
        delivered_at: data.validated.delivered_at,
        replacement: data.validated.replacement,
      }))
    )

    startReturnFlowStep(transform({ request }, (data) => ({ request_id: data.request.id })))

    return new WorkflowResponse(transform({ request }, (data) => data.request))
  }
)
