import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

/**
 * Whether the cart already became an order. Medusa runs the validate hook again
 * on a repeat completion (a webhook retry, a duplicate event, the browser and
 * the webhook racing) and then returns the existing order. Refusing there would
 * make Medusa refund the payment of an order that was placed, so the checks
 * only run on the first completion.
 */
export async function alreadyOrdered(
  cart: { id: string; completed_at?: unknown },
  container: MedusaContainer
): Promise<boolean> {
  if (cart.completed_at) return true
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order_cart",
    fields: ["order_id"],
    filters: { cart_id: cart.id },
  })
  return data.length > 0
}
