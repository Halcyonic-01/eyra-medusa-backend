import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  deleteCartCreditLinesWorkflow,
  refreshPaymentCollectionForCartWorkflow,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { extractWalletCreditLinesStep } from "./steps/extract-wallet-credit-lines"

export type RemoveWalletFromCartInput = {
  cart_id: string
}

/** Takes any wallet credit off a cart, so the customer pays the full total. */
export const removeWalletFromCartWorkflow = createWorkflow(
  "remove-wallet-from-cart",
  function (input: RemoveWalletFromCartInput) {
    const { data: carts } = useQueryGraphStep({
      entity: "cart",
      fields: ["id", "completed_at", "credit_lines.*"],
      filters: { id: input.cart_id },
    })

    const walletLines = extractWalletCreditLinesStep({ records: carts })

    when("has-wallet-credit-lines", walletLines, (data) => data.ids.length > 0).then(() => {
      deleteCartCreditLinesWorkflow.runAsStep({
        input: { id: walletLines.ids },
      })
      refreshPaymentCollectionForCartWorkflow.runAsStep({
        input: { cart_id: input.cart_id },
      })
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

    const result = transform({ updatedCarts, walletLines }, (data) => ({
      cart: data.updatedCarts[0],
      removed_amount: data.walletLines.amount,
    }))

    return new WorkflowResponse(result)
  }
)
