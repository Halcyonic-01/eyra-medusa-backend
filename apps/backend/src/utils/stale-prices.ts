import { filterObjectByKeys } from "@medusajs/framework/utils"
import { toNumber } from "./commerce-rules"

/**
 * A cart line keeps the unit price it got when it was added. These helpers find
 * lines whose price no longer matches what Medusa would charge today, for
 * example after a sale price list ends or the admin changes a price.
 */

// Same keys Medusa builds its cart pricing context from (cartFieldsForPricingContext).
const PRICING_CONTEXT_KEYS = [
  "id",
  "sales_channel_id",
  "currency_code",
  "region_id",
  "shipping_address.city",
  "shipping_address.country_code",
  "shipping_address.province",
  "shipping_address.postal_code",
  "item_total",
  "total",
  "customer.id",
  "email",
  "customer.groups.id",
]

/** Cart fields needed to price its lines the way Medusa's cart refresh does. */
export const CART_PRICING_FIELDS = [
  ...PRICING_CONTEXT_KEYS,
  "region.*",
  "customer.*",
  "customer.groups.*",
  "items.id",
  "items.title",
  "items.variant_id",
  "items.quantity",
  "items.unit_price",
  "items.is_custom_price",
]

// Half a paisa: anything smaller is rounding, not a price change.
const PRICE_TOLERANCE = 0.005

export type PricedCartLine = {
  id: string
  title?: string | null
  variant_id?: string | null
  quantity?: unknown
  unit_price?: unknown
  is_custom_price?: boolean | null
}

export type CartForPricing = {
  id: string
  currency_code?: string | null
  region_id?: string | null
  customer_id?: string | null
  region?: { currency_code?: string | null } | null
  customer?: unknown
  items?: (PricedCartLine | null)[] | null
  [key: string]: unknown
}

export type PriceRequest = { id: string; variantId: string; context: Record<string, unknown> }

export type StalePriceLine = {
  id: string
  title: string
  unit_price: number
  /** What Medusa charges today, or null when the variant has no price at all. */
  current_price: number | null
}

/** Lines whose price comes from the variant: not custom priced and with a variant. */
export function repriceableLines(cart: CartForPricing): (PricedCartLine & { variant_id: string })[] {
  return (cart.items ?? []).filter(
    (line): line is PricedCartLine & { variant_id: string } =>
      Boolean(line?.variant_id) && !line?.is_custom_price
  )
}

/** One pricing request per line, with the same context Medusa uses (region, currency, customer, quantity). */
export function cartPriceRequests(cart: CartForPricing): PriceRequest[] {
  const base = {
    ...filterObjectByKeys(cart, PRICING_CONTEXT_KEYS),
    customer: cart.customer,
    region: cart.region,
    currency_code: cart.currency_code ?? cart.region?.currency_code,
    region_id: cart.region_id,
    customer_id: cart.customer_id,
  }
  return repriceableLines(cart).map((line) => ({
    id: line.id,
    variantId: line.variant_id,
    context: { ...base, quantity: toNumber(line.quantity) },
  }))
}

/**
 * Lines whose unit price differs from the variant's current calculated price.
 * `calculated` maps line id to Medusa's calculated price set.
 */
export function findStalePriceLines(
  cart: CartForPricing,
  calculated: Record<string, { calculated_amount?: unknown } | null | undefined>
): StalePriceLine[] {
  const stale: StalePriceLine[] = []
  for (const line of repriceableLines(cart)) {
    const unitPrice = toNumber(line.unit_price)
    const current = toNumber(calculated[line.id]?.calculated_amount)
    const known = Number.isFinite(current)
    if (known && Number.isFinite(unitPrice) && Math.abs(current - unitPrice) < PRICE_TOLERANCE) continue
    stale.push({
      id: line.id,
      title: line.title ?? "An item",
      unit_price: unitPrice,
      current_price: known ? current : null,
    })
  }
  return stale
}

const rupees = (amount: number) =>
  `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

/** The customer-facing refusal when an order would be placed at an old price. */
export function stalePriceMessage(stale: StalePriceLine[]): string {
  const changes = stale
    .map((line) =>
      line.current_price === null
        ? `${line.title} can no longer be bought`
        : `${line.title} is now ${rupees(line.current_price)} (was ${rupees(line.unit_price)})`
    )
    .join("; ")
  return `Prices in your cart have changed: ${changes}. Please review your cart and try again.`
}
