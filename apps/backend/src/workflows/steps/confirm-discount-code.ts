import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCartForRules } from "../../utils/cart-summary"
import { findDiscountCode } from "../../utils/commerce-rules"

export type ConfirmDiscountCodeInput = { cart_id: string; codes: string[] }

/**
 * After applying, checks Medusa really kept the code. Medusa drops a code
 * quietly when its budget is used up, which for WELCOME200 means the customer
 * has already had their one use.
 */
export const confirmDiscountCodeStep = createStep(
  "confirm-discount-code",
  async (input: ConfirmDiscountCodeInput, { container }) => {
    if (input.codes.length === 0) {
      return new StepResponse({ applied: [] as string[] })
    }

    const cart = await loadCartForRules(container, input.cart_id)
    const applied = (cart?.promotions ?? []).map((promotion) => promotion?.code).filter(Boolean) as string[]

    for (const code of input.codes) {
      if (applied.includes(code)) continue
      const entry = findDiscountCode(code)
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        entry?.oncePerCustomer
          ? `${code} has already been used on this account.`
          : `${code} could not be applied to this order.`
      )
    }
    return new StepResponse({ applied })
  }
)
