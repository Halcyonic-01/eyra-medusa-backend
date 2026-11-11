import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { addShippingMethodToCartWorkflow } from "@medusajs/medusa/core-flows"
import type { PaymentMode } from "../utils/commerce-rules"
import { findPaymentModeOptionStep } from "./steps/find-payment-mode-option"
import { refreshStaleCartPricesWorkflow } from "./refresh-stale-cart-prices"
import { markCheckoutCartStep } from "./steps/mark-checkout-cart"
import { voidCartLeftoversStep } from "./steps/void-orphan-order"

export type SetCartPaymentModeInput = { cart_id: string; mode: PaymentMode }

/**
 * Puts the right shipping method on a cart for how it will be paid: free for
 * prepaid, the Cash on Delivery charge for COD. The method replaces any
 * earlier one, so switching back and forth never stacks charges. Lines left at
 * an old price (a sale that ended) are repriced first, so checkout totals are current.
 */
export const setCartPaymentModeWorkflow = createWorkflow(
  "set-cart-payment-mode",
  function (input: SetCartPaymentModeInput) {
    markCheckoutCartStep({ cart_id: input.cart_id })
    // A leftover from a crashed completion of this cart gives back its code use first.
    voidCartLeftoversStep({ cart_id: input.cart_id })
    refreshStaleCartPricesWorkflow.runAsStep({ input: { cart_id: input.cart_id } })

    const optionId = findPaymentModeOptionStep({ mode: input.mode })

    const shippingInput = transform({ input, optionId }, (data) => ({
      cart_id: data.input.cart_id,
      options: [{ id: data.optionId }],
    }))
    addShippingMethodToCartWorkflow.runAsStep({ input: shippingInput })

    return new WorkflowResponse({ mode: input.mode })
  }
)
