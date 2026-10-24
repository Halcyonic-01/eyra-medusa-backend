import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { cartLines, loadCartForRules } from "../../utils/cart-summary"
import { cartViolations, toNumber } from "../../utils/commerce-rules"

type SessionLike = { provider_id?: string | null; status?: string | null }

// The same statuses Medusa itself will go on to process when completing.
const PROCESSABLE = ["pending", "requires_more", "authorized"]

/**
 * Launch-rules part of the last check before a cart becomes an order, whoever
 * is asking: prepaid orders ship free, Cash on Delivery orders carry the COD
 * charge exactly once, and at most one discount code applies and it fits the
 * order value.
 *
 * The storefront keeps all of this right as the cart changes. This is the
 * guarantee for anything that goes round it, such as calling Medusa directly.
 */
export async function validateCommerceRules(
  cart: { id: string; total?: unknown; payment_collection?: unknown },
  container: MedusaContainer
) {
  const loaded = await loadCartForRules(container, cart.id)
  if (!loaded) return

  const sessions = (((cart as { payment_collection?: { payment_sessions?: SessionLike[] } })
    .payment_collection?.payment_sessions ?? []) as SessionLike[]).filter(
    (session) => session.status && PROCESSABLE.includes(session.status)
  )
  const processed = sessions[0]?.provider_id

  const problems = cartViolations({
    lines: cartLines(loaded),
    shippingOptionCodes: (loaded.shipping_methods ?? [])
      .map((method) => method?.shipping_option?.type?.code)
      .filter(Boolean) as string[],
    paymentProviderIds: processed ? [processed] : [],
    amountDue: toNumber(cart.total),
    promoCodes: (loaded.promotions ?? []).map((promotion) => promotion?.code).filter(Boolean) as string[],
  })

  if (problems.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This order can't be placed yet: ${problems.join(" ")} Please review your cart and try again.`
    )
  }
}
