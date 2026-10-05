import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

type Input = {
  customer_id: string
  order_id?: string
  customers: { id: string; email?: string | null }[]
  orders?: { id: string; customer_id?: string | null; email?: string | null }[]
}

function sameEmail(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
}

/**
 * Staff issue credit against a customer and, optionally, the order being
 * returned or exchanged. Refuse when the customer does not exist or the order
 * belongs to someone else, so credit can never land in the wrong wallet.
 */
export const assertCreditTargetStep = createStep(
  "assert-credit-target",
  async (input: Input) => {
    const customer = input.customers[0]
    if (!customer) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Customer ${input.customer_id} was not found`
      )
    }

    if (input.order_id) {
      const order = input.orders?.[0]
      if (!order) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `Order ${input.order_id} was not found`
        )
      }

      const belongsToCustomer =
        order.customer_id === customer.id || sameEmail(order.email, customer.email)
      if (!belongsToCustomer) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "That order does not belong to this customer"
        )
      }
    }

    return new StepResponse({ customer_id: customer.id })
  }
)
