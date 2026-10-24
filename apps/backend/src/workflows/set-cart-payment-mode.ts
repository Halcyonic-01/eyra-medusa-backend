import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { addShippingMethodToCartWorkflow } from "@medusajs/medusa/core-flows"
import type { PaymentMode } from "../utils/commerce-rules"
import { findPaymentModeOptionStep } from "./steps/find-payment-mode-option"

export type SetCartPaymentModeInput = { cart_id: string; mode: PaymentMode }

/**
 * Puts the right shipping method on a cart for how it will be paid: free for
 * prepaid, the Cash on Delivery charge for COD. The method replaces any
 * earlier one, so switching back and forth never stacks charges.
 */
export const setCartPaymentModeWorkflow = createWorkflow(
  "set-cart-payment-mode",
  function (input: SetCartPaymentModeInput) {
    const optionId = findPaymentModeOptionStep({ mode: input.mode })

    const shippingInput = transform({ input, optionId }, (data) => ({
      cart_id: data.input.cart_id,
      options: [{ id: data.optionId }],
    }))
    addShippingMethodToCartWorkflow.runAsStep({ input: shippingInput })

    return new WorkflowResponse({ mode: input.mode })
  }
)
