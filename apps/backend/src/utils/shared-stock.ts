import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { toNumber } from "./commerce-rules"

/**
 * Medusa checks stock one cart line at a time. An anklet's Single and Pair draw
 * on the same stock (a Pair takes two), so a Single line and a Pair line can
 * each pass while together they need more anklets than there are. These checks
 * add up every line that shares a stock item. Items used by one line only are
 * left to Medusa's own check, so other products behave exactly as before.
 */

export type StockDemand = { variant_id: string; quantity: number }

export type StockVariant = {
  id: string
  product_title: string
  manage_inventory: boolean
  allow_backorder: boolean
  items: { inventory_item_id: string; required_quantity: number; available: number }[]
}

/** Lines that together need more of a shared stock item than is available. Pure. */
export function sharedStockShortfalls(demand: readonly StockDemand[], variants: readonly StockVariant[]): string[] {
  const quantityOf = new Map<string, number>()
  for (const line of demand) {
    quantityOf.set(line.variant_id, (quantityOf.get(line.variant_id) ?? 0) + line.quantity)
  }

  const perItem = new Map<string, { needed: number; available: number; variants: Set<string>; title: string }>()
  for (const variant of variants) {
    const quantity = quantityOf.get(variant.id) ?? 0
    if (!quantity || !variant.manage_inventory || variant.allow_backorder) continue
    for (const item of variant.items) {
      const entry = perItem.get(item.inventory_item_id) ?? {
        needed: 0,
        available: item.available,
        variants: new Set<string>(),
        title: variant.product_title,
      }
      entry.needed += item.required_quantity * quantity
      entry.variants.add(variant.id)
      perItem.set(item.inventory_item_id, entry)
    }
  }

  return [...perItem.values()]
    .filter((entry) => entry.variants.size > 1 && entry.needed > entry.available)
    .map((entry) =>
      `Only ${Math.max(0, entry.available)} of ${entry.title} ${entry.available === 1 ? "is" : "are"} in stock, and a pair counts as 2.`
    )
}

type VariantRow = {
  id: string
  manage_inventory?: boolean | null
  allow_backorder?: boolean | null
  product?: { title?: string | null } | null
  inventory_items?: ({
    inventory_item_id: string
    required_quantity?: unknown
    inventory?: { location_levels?: ({ stocked_quantity?: unknown; reserved_quantity?: unknown } | null)[] | null } | null
  } | null)[] | null
}

/** Loads the variants of the given lines with their stock, and returns any shared-stock shortfall. */
export async function findSharedStockShortfalls(
  container: MedusaContainer,
  demand: readonly StockDemand[]
): Promise<string[]> {
  const ids = [...new Set(demand.map((line) => line.variant_id).filter(Boolean))]
  if (ids.length < 2) return []

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "manage_inventory",
      "allow_backorder",
      "product.title",
      "inventory_items.inventory_item_id",
      "inventory_items.required_quantity",
      "inventory_items.inventory.location_levels.stocked_quantity",
      "inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { id: ids },
  })

  const variants: StockVariant[] = (data as VariantRow[]).map((row) => ({
    id: row.id,
    product_title: row.product?.title ?? "this product",
    manage_inventory: Boolean(row.manage_inventory),
    allow_backorder: Boolean(row.allow_backorder),
    items: (row.inventory_items ?? []).filter(Boolean).map((link) => ({
      inventory_item_id: link!.inventory_item_id,
      required_quantity: toNumber(link!.required_quantity) || 1,
      available: (link!.inventory?.location_levels ?? []).reduce(
        (sum, level) => sum + (toNumber(level?.stocked_quantity) || 0) - (toNumber(level?.reserved_quantity) || 0),
        0
      ),
    })),
  }))
  return sharedStockShortfalls(demand, variants)
}
