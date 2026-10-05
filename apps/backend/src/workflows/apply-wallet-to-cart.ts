import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  createCartCreditLinesWorkflow,
  deleteCartCreditLinesWorkflow,
  refreshPaymentCollectionForCartWorkflow,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { WALLET_CREDIT_LINE_REFERENCE } from "../modules/wallet/utils"
import { getWalletStep } from "./steps/get-wallet"
import { planWalletCartCreditStep } from "./steps/plan-wallet-cart-credit"

export type ApplyWalletToCartInput = {
  cart_id: string
  customer_id: string
}

/**
 * Puts the customer's wallet credit on a cart as a Medusa credit line. The
 * cart total drops by that amount, so the payment collection, Razorpay and
 * Cash on Delivery all charge only what is left. Nothing leaves the wallet
 * yet: the balance is deducted when the order is placed.
 *
 * Safe to call again: any wallet credit already on the cart is replaced.
 */
export const applyWalletToCartWorkflow = createWorkflow(
  "apply-wallet-to-cart",
  function (input: ApplyWalletToCartInput) {
    const lockKey = transform({ input }, (data) => `wallet:${data.input.customer_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const { data: carts } = useQueryGraphStep({
      entity: "cart",
      fields: [
        "id",
        "email",
        "customer_id",
        "currency_code",
        "total",
        "completed_at",
        "credit_lines.*",
      ],
      filters: { id: input.cart_id },
    })

    const { data: customers } = useQueryGraphStep({
      entity: "customer",
      fields: ["id", "email"],
      filters: { id: input.customer_id },
    }).config({ name: "find-customer" })

    const wallet = getWalletStep({ customer_id: input.customer_id })

    const plan = planWalletCartCreditStep({
      customer_id: input.customer_id,
      carts,
      customers,
      wallet,
    })

    when("has-existing-wallet-credit", plan, (data) => data.remove_ids.length > 0).then(() => {
      deleteCartCreditLinesWorkflow.runAsStep({
        input: { id: plan.remove_ids },
      })
    })

    const creditLineInput = transform({ input, plan }, (data) => [
      {
        cart_id: data.input.cart_id,
        amount: data.plan.amount,
        reference: WALLET_CREDIT_LINE_REFERENCE,
        reference_id: data.plan.wallet_id,
        metadata: { customer_id: data.input.customer_id },
      },
    ])
    createCartCreditLinesWorkflow.runAsStep({ input: creditLineInput })

    // Re-sync the payment collection with the new total. This also clears any
    // payment session that was opened for the old amount.
    refreshPaymentCollectionForCartWorkflow.runAsStep({
      input: { cart_id: input.cart_id },
    })

    const { data: updatedCarts } = useQueryGraphStep({
      entity: "cart",
      fields: [
        "id",
        "total",
        "subtotal",
        "tax_total",
        "shipping_total",
        "discount_total",
        "credit_line_total",
      ],
      filters: { id: input.cart_id },
    }).config({ name: "find-updated-cart" })

    releaseLockStep({ key: lockKey })

    const result = transform({ updatedCarts, plan }, (data) => ({
      cart: data.updatedCarts[0],
      applied_amount: data.plan.amount,
      wallet_balance: data.plan.wallet_balance,
      cart_total_without_wallet: data.plan.cart_total_without_wallet,
    }))

    return new WorkflowResponse(result)
  }
)
