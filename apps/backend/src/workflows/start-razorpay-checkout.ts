import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  createPaymentCollectionForCartWorkflow,
  createPaymentSessionsWorkflow,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { RAZORPAY_PROVIDER_ID } from "../modules/payment-snapshot/rules"
import { findStaleCartPricesWorkflow } from "./find-stale-cart-prices"
import { refreshStaleCartPricesWorkflow } from "./refresh-stale-cart-prices"
import { guardRazorpayCheckoutStep } from "./steps/guard-razorpay-checkout"
import { markCheckoutCartStep } from "./steps/mark-checkout-cart"
import { voidCartLeftoversStep } from "./steps/void-orphan-order"
import { recordPriceSnapshotStep } from "./steps/record-price-snapshot"

export type StartRazorpayCheckoutInput = { cart_id: string }

/**
 * Opens a Razorpay payment for a cart and records its price snapshot. The cart
 * is repriced to today's prices first, so a snapshot is never taken at an old
 * price; a cart already paid for is refused instead of being charged twice.
 */
export const startRazorpayCheckoutWorkflow = createWorkflow(
  "start-razorpay-checkout",
  function (input: StartRazorpayCheckoutInput) {
    const lockKey = transform({ input }, (data) => `razorpay-checkout:${data.input.cart_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })

    guardRazorpayCheckoutStep({ cart_id: input.cart_id })
    markCheckoutCartStep({ cart_id: input.cart_id })
    // A leftover from a crashed completion of this cart gives back its code use first.
    voidCartLeftoversStep({ cart_id: input.cart_id })

    refreshStaleCartPricesWorkflow.runAsStep({ input: { cart_id: input.cart_id } })

    const { data: before } = useQueryGraphStep({
      entity: "cart",
      fields: ["id", "payment_collection.id"],
      filters: { id: input.cart_id },
    }).config({ name: "find-payment-collection" })

    when("cart-needs-payment-collection", { before }, (data) => !data.before[0]?.payment_collection?.id).then(() => {
      createPaymentCollectionForCartWorkflow.runAsStep({ input: { cart_id: input.cart_id } })
    })

    const { data: after } = useQueryGraphStep({
      entity: "cart",
      fields: ["id", "payment_collection.id"],
      filters: { id: input.cart_id },
    }).config({ name: "load-payment-collection" })

    const sessionInput = transform({ after }, (data) => ({
      payment_collection_id: data.after[0].payment_collection!.id,
      provider_id: RAZORPAY_PROVIDER_ID,
    }))
    createPaymentSessionsWorkflow.runAsStep({ input: sessionInput })

    // Checked again after opening the payment: a sale could end in between.
    const stale = findStaleCartPricesWorkflow.runAsStep({ input: { cart_id: input.cart_id } })
    const snapshot = recordPriceSnapshotStep({ cart_id: input.cart_id, stale })

    releaseLockStep({ key: lockKey })

    const result = transform({ snapshot }, (data) => ({
      payment_collection_id: data.snapshot.payment_collection_id,
      payment_session_id: data.snapshot.payment_session_id,
      razorpay_order_id: data.snapshot.razorpay_order_id,
      amount: data.snapshot.amount_paise / 100,
    }))
    return new WorkflowResponse(result)
  }
)
