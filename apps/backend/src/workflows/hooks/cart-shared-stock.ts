import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { addToCartWorkflow, updateLineItemInCartWorkflow } from "@medusajs/medusa/core-flows"
import { toNumber } from "../../utils/commerce-rules"
import { findSharedStockShortfalls, type StockDemand } from "../../utils/shared-stock"

type CartLike = { items?: ({ id: string; variant_id?: string | null; quantity?: unknown } | null)[] | null }

function cartDemand(cart: CartLike, override?: { id: string; quantity: number }): StockDemand[] {
  return (cart.items ?? [])
    .filter((item): item is NonNullable<typeof item> & { variant_id: string } => Boolean(item?.variant_id))
    .map((item) => ({
      variant_id: item.variant_id,
      quantity: override && item.id === override.id ? override.quantity : toNumber(item.quantity) || 0,
    }))
}

async function refuseShortfalls(container: Parameters<typeof findSharedStockShortfalls>[0], demand: StockDemand[]) {
  const problems = await findSharedStockShortfalls(container, demand)
  if (problems.length) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, problems.join(" "))
  }
}

// Adding to the cart: what is already there plus what is being added. This hook
// is handed the cart without its lines, so they are loaded here.
addToCartWorkflow.hooks.validate(async ({ input }, { container }) => {
  const adding = ((input as { items?: { variant_id?: string; quantity?: unknown }[] }).items ?? [])
    .filter((item): item is { variant_id: string; quantity?: unknown } => Boolean(item.variant_id))
    .map((item) => ({ variant_id: item.variant_id, quantity: toNumber(item.quantity) || 0 }))
  if (!adding.length) return
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: ["id", "items.id", "items.variant_id", "items.quantity"],
    filters: { id: (input as { cart_id: string }).cart_id },
  })
  await refuseShortfalls(container, [...cartDemand((data[0] ?? {}) as CartLike), ...adding])
})

// Changing a line's quantity: the cart as it would be after the change.
updateLineItemInCartWorkflow.hooks.validate(async ({ input, cart }, { container }) => {
  const change = input as { item_id: string; update?: { quantity?: unknown } }
  const quantity = toNumber(change.update?.quantity)
  if (!Number.isFinite(quantity)) return
  await refuseShortfalls(container, cartDemand(cart as CartLike, { id: change.item_id, quantity }))
})
