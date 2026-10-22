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
  price_set?: { prices?: { amount?: unknown; currency_code?: string | null; rules_count?: number | null }[] } | null
  inventory_items?: {
    inventory?: { location_levels?: { stocked_quantity?: unknown; reserved_quantity?: unknown }[] | null } | null
  }[] | null
}

/** The price in rupees: the plain INR price, with no rules attached to it. */
export function plainInrPrice(variant: VariantRow): number | null {
  const prices = (variant.price_set?.prices ?? []).filter((price) => (price.currency_code ?? "").toLowerCase() === "inr")
  const plain = prices.find((price) => !price.rules_count) ?? prices[0]
  const amount = Number(plain?.amount)
  return Number.isFinite(amount) ? amount : null
}

function unitsAvailable(variant: VariantRow): number {
  if (variant.manage_inventory === false || variant.allow_backorder) return Number.POSITIVE_INFINITY
  let units = 0
  for (const item of variant.inventory_items ?? []) {
    for (const level of item.inventory?.location_levels ?? []) {
      units += Number(level.stocked_quantity ?? 0) - Number(level.reserved_quantity ?? 0)
    }
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
