import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { useQueryGraphStep } from "@medusajs/medusa/core-flows"
import {
  createReturnRequestStep,
  type ReturnRequestReason,
  type ReturnRequestType,
} from "./steps/create-return-request"
import { validateReturnRequestStep } from "./steps/validate-return-request"

export type CreateReturnRequestInput = {
  customer_id: string
  order_id: string
  type: ReturnRequestType
  reason: ReturnRequestReason
  note?: string
  items: { item_id: string; quantity: number }[]
}

/**
 * Records a customer's request to return or exchange items from an order, after
 * checking it is theirs and the items and quantities are valid.
 */
export const createReturnRequestWorkflow = createWorkflow(
  "create-return-request",
  function (input: CreateReturnRequestInput) {
    const { data: orders } = useQueryGraphStep({
      entity: "order",
      fields: [
        "id",
        "customer_id",
        "email",
        "status",
        "items.id",
        "items.title",
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

    const items = validateReturnRequestStep({
      customer_id: input.customer_id,
      order_id: input.order_id,
      items: input.items,
      orders,
      customers,
    })

    const request = createReturnRequestStep(
      transform({ input, items }, (data) => ({
        order_id: data.input.order_id,
        customer_id: data.input.customer_id,
        type: data.input.type,
        reason: data.input.reason,
        note: data.input.note ?? null,
        items: data.items,
      }))
    )

    return new WorkflowResponse(request)
  }
)
