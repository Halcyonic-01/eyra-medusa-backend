import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { refreshCartItemsWorkflow } from "@medusajs/medusa/core-flows"
import { findStaleCartPricesWorkflow } from "./find-stale-cart-prices"
import { reconcileCartToteWorkflow } from "./reconcile-cart-tote"
import { checkPaidSnapshotStep } from "./steps/check-paid-snapshot"

export type RefreshStaleCartPricesInput = { cart_id: string }

/**
 * Reprices a cart's lines to today's prices, but only when one has gone stale
 * (a sale ended, a price changed). The tote is rechecked after, since a lower
 * subtotal can drop it below the threshold. A cart already paid for at its
 * Razorpay snapshot price is left alone, so that payment can still complete.
 */
export const refreshStaleCartPricesWorkflow = createWorkflow(
  "refresh-stale-cart-prices",
  function (input: RefreshStaleCartPricesInput) {
    const stale = findStaleCartPricesWorkflow.runAsStep({ input: { cart_id: input.cart_id } })

    const checkInput = transform({ input, stale }, (data) => ({
      cart_id: data.input.cart_id,
      stale_count: data.stale.length,
    }))
    const paid = checkPaidSnapshotStep(checkInput)

    const shouldReprice = transform({ stale, paid }, (data) => data.stale.length > 0 && !data.paid.hold_prices)

    when("cart-has-stale-prices", { shouldReprice }, (data) => data.shouldReprice).then(() => {
      refreshCartItemsWorkflow.runAsStep({
        input: { cart_id: input.cart_id, force_refresh: true },
      })
      reconcileCartToteWorkflow.runAsStep({ input: { cart_id: input.cart_id } })
    })

    const result = transform({ stale, shouldReprice, paid }, (data) => ({
      repriced: data.shouldReprice ? data.stale : [],
      held_for_payment: data.stale.length > 0 && data.paid.hold_prices,
    }))
    return new WorkflowResponse(result)
  }
)
