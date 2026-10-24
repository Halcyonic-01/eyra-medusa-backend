import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { updateCartPromotionsWorkflow } from "@medusajs/medusa/core-flows"
import { PromotionActions } from "@medusajs/framework/utils"
import { checkDiscountCodeStep } from "./steps/check-discount-code"
import { confirmDiscountCodeStep } from "./steps/confirm-discount-code"

export type ApplyDiscountCodeInput = { cart_id: string; code: string | null }

/**
 * Puts one discount code on a cart, or takes the code off when `code` is null.
 * The code replaces whatever was there, so two codes can never stack.
 */
export const applyDiscountCodeWorkflow = createWorkflow(
  "apply-discount-code",
  function (input: ApplyDiscountCodeInput) {
    const checked = checkDiscountCodeStep({ cart_id: input.cart_id, code: input.code })

    const promotionInput = transform({ input, checked }, (data) => ({
      cart_id: data.input.cart_id,
      promo_codes: data.checked.codes,
      action: PromotionActions.REPLACE,
    }))
    updateCartPromotionsWorkflow.runAsStep({ input: promotionInput })

    const confirmed = confirmDiscountCodeStep({ cart_id: input.cart_id, codes: checked.codes })

    return new WorkflowResponse(confirmed)
  }
)
