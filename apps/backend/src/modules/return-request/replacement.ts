import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { TOTE_SKU } from "../../utils/commerce-rules"

/**
 * The item a customer wants instead, for an exchange: a published product's
 * variant that is on sale, has a price, and is in stock. The price is read from
 * Medusa, never taken from the request.
 */

export type Replacement = {
  variant_id: string
  title: string
  sku: string | null
  price: number
}

type VariantRow = {
  id: string
  title?: string | null
  sku?: string | null
  manage_inventory?: boolean | null
  allow_backorder?: boolean | null
  product?: { title?: string | null; status?: string | null; metadata?: Record<string, unknown> | null } | null
  price_set?: {
    prices?: { amount?: unknown; currency_code?: string | null; rules_count?: number | null; price_list_id?: string | null }[]
  } | null
  inventory_items?: {
    required_quantity?: unknown
    inventory?: { location_levels?: { stocked_quantity?: unknown; reserved_quantity?: unknown }[] | null } | null
  }[] | null
}

/** The price in rupees: the plain INR price, with no rules attached to it and not from a sale price list. */
export function plainInrPrice(variant: VariantRow): number | null {
  const prices = (variant.price_set?.prices ?? []).filter(
    (price) => (price.currency_code ?? "").toLowerCase() === "inr" && !price.price_list_id
  )
  const plain = prices.find((price) => !price.rules_count) ?? prices[0]
  const amount = Number(plain?.amount)
  return Number.isFinite(amount) ? amount : null
}

/** Units of the variant that can be sold. An anklet Pair takes two of its stock item, so 3 anklets are 1 Pair. */
export function unitsAvailable(variant: VariantRow): number {
  if (variant.manage_inventory === false || variant.allow_backorder) return Number.POSITIVE_INFINITY
  const items = variant.inventory_items ?? []
  if (!items.length) return 0
  let units = Number.POSITIVE_INFINITY
  for (const item of items) {
    let pieces = 0
    for (const level of item.inventory?.location_levels ?? []) {
      pieces += Number(level.stocked_quantity ?? 0) - Number(level.reserved_quantity ?? 0)
    }
    units = Math.min(units, Math.floor(pieces / (Number(item.required_quantity) || 1)))
  }
  return units
}

export type ReplacementResult = { ok: true; replacement: Replacement } | { ok: false; error: string }

export async function loadReplacement(container: MedusaContainer, variantId: string): Promise<ReplacementResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "title",
      "sku",
      "manage_inventory",
      "allow_backorder",
      "product.title",
      "product.status",
      "product.metadata",
      "price_set.prices.amount",
      "price_set.prices.currency_code",
      "price_set.prices.rules_count",
      "price_set.prices.price_list_id",
      "inventory_items.required_quantity",
      "inventory_items.inventory.location_levels.stocked_quantity",
      "inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { id: variantId },
  })
  const variant = data[0] as unknown as VariantRow | undefined
  const hidden = variant?.product?.metadata?.hidden_from_shop
  if (!variant || variant.product?.status !== "published" || hidden === true || hidden === "true" || variant.sku === TOTE_SKU) {
    return { ok: false, error: "That replacement is not available." }
  }
  const price = plainInrPrice(variant)
  if (price === null || price <= 0) return { ok: false, error: "That replacement is not available." }
  if (unitsAvailable(variant) < 1) return { ok: false, error: "That replacement is out of stock right now." }

  const title = variant.product?.title ?? "Item"
  const option = (variant.title ?? "").trim()
  return {
    ok: true,
    replacement: {
      variant_id: variant.id,
      title: !option || option === "Default Title" || option === title ? title : `${title} (${option})`,
      sku: variant.sku ?? null,
      price,
    },
  }
}
