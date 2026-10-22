import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { addToCartWorkflow, deleteLineItemsWorkflow, updateLineItemInCartWorkflow } from "@medusajs/medusa/core-flows"
import { cartLines, loadCartForRules } from "../../utils/cart-summary"
import { TOTE_SKU, isToteLine, merchandiseSubtotal, qualifiesForTote, toNumber } from "../../utils/commerce-rules"

export type ToteStatus =
  | "unchanged"
  | "added"
  | "removed"
  | "fixed"
  /** The order qualifies but the tote is out of stock. */
  | "out_of_stock"
  /** The tote product has not been set up in this store. */
  | "not_set_up"
  | "cart_completed"

/**
 * Makes the cart's complimentary tote right: one tote, at zero price, while the
 * items are worth more than ₹1,499 and the tote is in stock; no tote otherwise.
 * It never raises an error for stock: an order without a tote is a fine order.
 */
export const reconcileToteStep = createStep(
  "reconcile-tote",
  async (input: { cart_id: string }, { container }) => {
    const cart = await loadCartForRules(container, input.cart_id)
    if (!cart || cart.completed_at) {
      return new StepResponse<ToteStatus>("cart_completed")
    }

    const lines = cartLines(cart)
    const toteLines = lines.filter(isToteLine)
    const qualifies = qualifiesForTote(merchandiseSubtotal(lines))

    if (!qualifies) {
      if (!toteLines.length) return new StepResponse<ToteStatus>("unchanged")
      await deleteLineItemsWorkflow(container).run({
        input: { cart_id: cart.id, ids: toteLines.map((line) => line.id) },
      })
      return new StepResponse<ToteStatus>("removed")
    }

    if (toteLines.length) {
      const units = toteLines.reduce((sum, line) => sum + (Number(toNumber(line.quantity)) || 0), 0)
      if (toteLines.length === 1 && units === 1) return new StepResponse<ToteStatus>("unchanged")
      // Two calls at once, or a direct API call, left more than one tote: keep a single one.
      const [keep, ...extra] = toteLines
      if (extra.length) {
        await deleteLineItemsWorkflow(container).run({
          input: { cart_id: cart.id, ids: extra.map((line) => line.id) },
        })
      }
      if (toNumber(keep.quantity) !== 1) {
        await updateLineItemInCartWorkflow(container).run({
          input: { cart_id: cart.id, item_id: keep.id, update: { quantity: 1 } },
        })
      }
      return new StepResponse<ToteStatus>("fixed")
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id"],
      filters: { sku: TOTE_SKU },
    })
    const variantId = variants[0]?.id as string | undefined
    if (!variantId) return new StepResponse<ToteStatus>("not_set_up")

    const { errors } = await addToCartWorkflow(container).run({
      input: { cart_id: cart.id, items: [{ variant_id: variantId, quantity: 1 }] },
      throwOnError: false,
    })
    if (errors.length) {
      const message = errors[0]?.error?.message ?? ""
      if (/inventory/i.test(message)) return new StepResponse<ToteStatus>("out_of_stock")
      throw errors[0].error
    }
    return new StepResponse<ToteStatus>("added")
  }
)
