import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { cartLines, loadCartForRules } from "../../utils/cart-summary"
import {
  checkDiscountEligibility,
  findDiscountCode,
  merchandiseSubtotal,
} from "../../utils/commerce-rules"

export type CheckDiscountCodeInput = { cart_id: string; code: string | null }

/**
 * Decides whether a code may go on the cart, with a message the customer can
 * read. Medusa re-checks the order-value minimum and the once-per-customer
 * budget itself; this step exists to say why, and to refuse an unknown code
 * before anything changes.
 */
export const checkDiscountCodeStep = createStep(
  "check-discount-code",
  async (input: CheckDiscountCodeInput, { container }) => {
    if (input.code === null) {
      return new StepResponse({ codes: [] as string[] })
    }

    const entry = findDiscountCode(input.code)
    if (!entry) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "That code is not valid.")
    }

    const cart = await loadCartForRules(container, input.cart_id)
    if (!cart) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
    }
    if (cart.completed_at) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This order has already been placed.")
    }

    if (entry.oncePerCustomer && !cart.customer_id) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Sign in to use ${entry.code}. It can be used once per account.`
      )
    }

    const verdict = checkDiscountEligibility(entry, merchandiseSubtotal(cartLines(cart)))
    if (!verdict.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, verdict.message)
    }

    return new StepResponse({ codes: [entry.code] })
  }
)
