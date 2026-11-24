import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  createPaymentCollectionForCartWorkflow,
  createPaymentSessionsWorkflow,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { PAYU_PROVIDER_ID, checkoutLockKey } from "../modules/payment-snapshot/gateways/ids"
import { findStaleCartPricesWorkflow } from "./find-stale-cart-prices"
import { refreshStaleCartPricesWorkflow } from "./refresh-stale-cart-prices"
import { guardRazorpayCheckoutStep } from "./steps/guard-razorpay-checkout"
import { markCheckoutCartStep } from "./steps/mark-checkout-cart"
import { voidCartLeftoversStep } from "./steps/void-orphan-order"
import { recordPriceSnapshotStep } from "./steps/record-price-snapshot"

export type StartPayuCheckoutInput = { cart_id: string }

/**
 * Opens a PayU attempt (a new transaction id) for a cart and records its price
 * snapshot, exactly as Razorpay's checkout does: same lock, same guard (which
 * also refuses while a payment with another provider is still in progress),
 * same repricing and snapshot. The hosted-checkout form is signed afterwards.
 */
export const startPayuCheckoutWorkflow = createWorkflow(
  "start-payu-checkout",
  function (input: StartPayuCheckoutInput) {
    // Shared with every provider's checkout and the late-payment settle.
    const lockKey = transform({ input }, (data) => checkoutLockKey(data.input.cart_id))
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 120 })

    guardRazorpayCheckoutStep({ cart_id: input.cart_id, provider_id: PAYU_PROVIDER_ID })
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
      provider_id: PAYU_PROVIDER_ID,
    }))
    createPaymentSessionsWorkflow.runAsStep({ input: sessionInput })

    // Checked again after opening the payment: a sale could end in between.
    const stale = findStaleCartPricesWorkflow.runAsStep({ input: { cart_id: input.cart_id } })
    const snapshot = recordPriceSnapshotStep({ cart_id: input.cart_id, stale })

    releaseLockStep({ key: lockKey })

    const result = transform({ snapshot }, (data) => ({
      payment_collection_id: data.snapshot.payment_collection_id,
      payment_session_id: data.snapshot.payment_session_id,
      txnid: data.snapshot.provider_ref as string,
      amount_paise: data.snapshot.amount_paise,
    }))
    return new WorkflowResponse(result)
  }
)
