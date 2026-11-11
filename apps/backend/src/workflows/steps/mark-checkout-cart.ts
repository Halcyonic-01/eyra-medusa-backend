import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { CHECKOUT_MARKER } from "../../modules/order-dispatch/order-integrity"

/**
 * Writes the cart's own id into its metadata. Medusa copies cart metadata onto
 * the order it becomes, which lets recovery tell an interrupted checkout's
 * leftover order from one made in the admin. Merged, so nothing else is lost.
 */
export const markCheckoutCartStep = createStep(
  "mark-checkout-cart",
  async (input: { cart_id: string }, { container }) => {
    const carts = container.resolve(Modules.CART)
    const [cart] = await carts.listCarts({ id: input.cart_id }, { select: ["id", "metadata"] })
    if (cart && (cart.metadata as Record<string, unknown> | null)?.[CHECKOUT_MARKER] !== cart.id) {
      await carts.updateCarts(cart.id, { metadata: { [CHECKOUT_MARKER]: cart.id } })
    }
    return new StepResponse(true)
  }
)
