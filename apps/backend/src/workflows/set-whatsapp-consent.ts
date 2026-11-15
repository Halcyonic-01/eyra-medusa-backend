import { MedusaError, Modules } from "@medusajs/framework/utils"
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"

const setWhatsappConsentStep = createStep(
  "set-whatsapp-consent",
  async (input: { cart_id: string; opt_in: boolean }, { container }) => {
    const carts = container.resolve(Modules.CART)
    const [cart] = await carts.listCarts({ id: input.cart_id }, { select: ["id", "metadata", "completed_at"], take: 1 })
    if (!cart) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found.")
    if ((cart as any).completed_at) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This cart is already an order.")
    const before = ((cart as any).metadata ?? {}) as Record<string, unknown>
    await carts.updateCarts(input.cart_id, {
      metadata: { ...before, whatsapp_opt_in: input.opt_in, whatsapp_opt_in_at: new Date().toISOString() },
    })
    return new StepResponse({ opt_in: input.opt_in }, { id: input.cart_id, metadata: before })
  },
  async (before, { container }) => {
    if (!before) return
    await container.resolve(Modules.CART).updateCarts(before.id, { metadata: before.metadata })
  }
)

/**
 * Records whether the customer agreed at checkout to WhatsApp messages about
 * their order (including the review request). It lives on the cart and so on the
 * order it becomes; the rest of the cart's metadata is kept as it is.
 */
export const setWhatsappConsentWorkflow = createWorkflow("set-whatsapp-consent", function (input: { cart_id: string; opt_in: boolean }) {
  return new WorkflowResponse(setWhatsappConsentStep(input))
})
