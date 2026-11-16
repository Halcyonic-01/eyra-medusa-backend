import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { useQueryGraphStep } from "@medusajs/medusa/core-flows"
import { RETURN_ORDER_FIELDS, type CreateReturnRequestInput } from "./create-return-request"
import { validateReturnRequestStep } from "./steps/validate-return-request"

export type ReturnRequestQuote = {
  type: "return" | "exchange"
  /** What the customer paid for the items, after any discount. */
  paid_value: number
  /** A return: the reverse fee kept from the credit. */
  fee_amount: number | null
  /** An exchange: the replacement and its price, read from Medusa. */
  replacement_title: string | null
  replacement_price: number | null
  /** Replacement price less what was paid; positive when the customer pays more. */
  price_difference: number | null
  /** What the customer pays before the pickup is booked: 0 when nothing is owed. */
  amount_due: number
  /** Store credit when it is done: a return's credit, or an exchange's lower price. */
  credit: number
}

/**
 * Works out what a request would cost or give back, with exactly the checks and
 * figures a real request uses, and saves nothing. The customer sees this before
 * they confirm, so what they are asked to pay is what the payment link asks for.
 */
export const quoteReturnRequestWorkflow = createWorkflow(
  "quote-return-request",
  function (input: CreateReturnRequestInput) {
    const { data: orders } = useQueryGraphStep({
      entity: "order",
      fields: RETURN_ORDER_FIELDS,
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

    return new WorkflowResponse(
      transform({ input, validated }, (data): ReturnRequestQuote => {
        const v = data.validated
        const r = v.replacement
        const returnCredit = Math.max(0, Math.round((v.paid_value - (v.fee_amount ?? 0)) * 100) / 100)
        return {
          type: data.input.type,
          paid_value: v.paid_value,
          fee_amount: v.fee_amount,
          replacement_title: r?.title ?? null,
          replacement_price: r?.price ?? null,
          price_difference: r?.price_difference ?? null,
          amount_due: r?.amount_due ?? 0,
          credit: r ? (r.price_difference < 0 ? Math.round(-r.price_difference * 100) / 100 : 0) : returnCredit,
        }
      })
    )
  }
)
