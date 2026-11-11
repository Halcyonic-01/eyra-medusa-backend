import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { getVariantPriceSetsStep, useQueryGraphStep } from "@medusajs/medusa/core-flows"
import {
  CART_PRICING_FIELDS,
  cartPriceRequests,
  findStalePriceLines,
  type CartForPricing,
} from "../utils/stale-prices"

export type FindStaleCartPricesInput = { cart_id: string }

/**
 * Lists the cart lines whose unit price no longer matches the variant's current
 * price for the cart's region, currency, customer and quantity. Read only.
 */
export const findStaleCartPricesWorkflow = createWorkflow(
  "find-stale-cart-prices",
  function (input: FindStaleCartPricesInput) {
    const { data: carts } = useQueryGraphStep({
      entity: "cart",
      fields: CART_PRICING_FIELDS,
      filters: { id: input.cart_id },
    }).config({ name: "load-cart-for-pricing" })

    const requests = transform({ carts }, (data) => {
      const cart = data.carts[0] as unknown as CartForPricing | undefined
      return { data: cart ? cartPriceRequests(cart) : [] }
    })

    const calculated = getVariantPriceSetsStep(requests)

    const stale = transform({ carts, calculated }, (data) => {
      const cart = data.carts[0] as unknown as CartForPricing | undefined
      return cart ? findStalePriceLines(cart, data.calculated) : []
    })

    return new WorkflowResponse(stale)
  }
)
