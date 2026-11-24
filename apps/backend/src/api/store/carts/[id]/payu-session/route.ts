import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { buildCheckoutForm } from "../../../../../modules/payu-payment/checkout-form"
import { payuConfig } from "../../../../../modules/payu-payment/config"
import { loadCartSummary } from "../../../../../utils/cart-summary"
import { startPayuCheckoutWorkflow } from "../../../../../workflows/start-payu-checkout"

/**
 * POST /store/carts/:id/payu-session
 *
 * Opens a PayU attempt for the cart at today's prices and returns the signed
 * hosted-checkout form for the storefront to post to PayU. Takes no amounts
 * from the caller. Refused while the cart is paid, or while a payment with
 * another provider is still being confirmed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const config = payuConfig()
  if (!config || !config.successUrl || !config.failureUrl) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "PayU is not available")
  const cartId = req.params.id

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: ["id", "email", "shipping_address.first_name", "shipping_address.last_name", "shipping_address.phone"],
    filters: { id: cartId },
  })
  const customer = data[0] as { email?: string | null; shipping_address?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null } | undefined
  if (!customer) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  if (!customer.email || !customer.shipping_address?.phone) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "An email and a phone number are needed to pay with PayU")
  }

  const { result } = await startPayuCheckoutWorkflow(req.scope).run({ input: { cart_id: cartId } })
  const form = buildCheckoutForm(config, {
    txnid: result.txnid,
    amount_paise: result.amount_paise,
    cart_id: cartId,
    customer: {
      email: customer.email,
      firstname: customer.shipping_address.first_name ?? "",
      lastname: customer.shipping_address.last_name ?? "",
      phone: customer.shipping_address.phone,
    },
  })
  const cart = await loadCartSummary(req.scope, cartId)
  return res.json({
    payment_collection_id: result.payment_collection_id,
    payment_session_id: result.payment_session_id,
    txnid: result.txnid,
    amount: result.amount_paise / 100,
    form,
    cart,
  })
}
