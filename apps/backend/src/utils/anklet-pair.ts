import { shipmentItemType } from "./product-type"

/**
 * Every anklet is sold as a Single or a Pair. The admin only sets the Single
 * price; the Pair is its own variant, kept by the backend at two singles less a
 * fixed amount, and it draws two units from the Single's stock.
 */
export const PACK_OPTION = "Pack"
export const SINGLE = "Single"
export const PAIR = "Pair"

/** Rupees taken off two singles when they are bought as a pair. */
export const PAIR_DISCOUNT = 200

/** The option Medusa adds to a product created without options. It carries no choice. */
const PLACEHOLDER_OPTION = "Default option"

/** Pair price for a single price: two singles less the pair discount, never below zero. */
export function pairPrice(single: number): number {
  return Math.max(0, Math.round(single * 2 - PAIR_DISCOUNT))
}

export function isAnkletType(typeValue: string | null | undefined): boolean {
  return Boolean(typeValue?.trim()) && shipmentItemType(typeValue) === "anklet"
}

export type PairVariant = {
  id: string
  title: string | null
  sku: string | null
  manage_inventory: boolean
  /** Option title to value. */
  options: Record<string, string>
  /** The plain INR price (no price list, no rules), if there is one. */
  inr: { id: string; amount: number } | null
  inventory: { inventory_item_id: string; required_quantity: number }[]
}

export type PairProduct = {
  id: string
  type: string | null
  options: { title: string; values: string[] }[]
  variants: PairVariant[]
}

export type PairPlan =
  | { kind: "skip"; reason: string }
  | { kind: "in_sync" }
  | {
      kind: "apply"
      /** Turn a one-variant anklet into Pack: Single, keeping its variant as the Single. */
      restructure: {
        options: { title: string; values: string[] }[]
        single: { id: string; title: string; options: Record<string, string> }
      } | null
      createPair: {
        product_id: string
        title: string
        sku?: string
        manage_inventory: boolean
        options: Record<string, string>
        prices: { amount: number; currency_code: string }[]
        inventory_items?: { inventory_item_id: string; required_quantity: number }[]
      } | null
      reprice: { variant_id: string; price_id: string | null; amount: number } | null
    }

function pairVariantInput(product: PairProduct, single: PairVariant, kept: Record<string, string>, amount: number) {
  return {
    product_id: product.id,
    title: PAIR,
    ...(single.sku ? { sku: `${single.sku}-pair` } : {}),
    manage_inventory: single.manage_inventory,
    options: { ...kept, [PACK_OPTION]: PAIR },
    prices: [{ amount, currency_code: "inr" }],
    ...(single.manage_inventory
      ? {
          inventory_items: single.inventory.map((item) => ({
            inventory_item_id: item.inventory_item_id,
            required_quantity: item.required_quantity * 2,
          })),
        }
      : {}),
  }
}

/** What has to change so an anklet has a Single and a correctly priced Pair. Pure, so it is tested alone. */
export function planPairSync(product: PairProduct): PairPlan {
  if (!isAnkletType(product.type)) return { kind: "skip", reason: "not an anklet" }

  const pack = product.options.find((option) => option.title === PACK_OPTION)

  if (pack) {
    if (!pack.values.includes(SINGLE) || !pack.values.includes(PAIR)) {
      return { kind: "skip", reason: `the ${PACK_OPTION} option needs both ${SINGLE} and ${PAIR}` }
    }
    const single = product.variants.find((variant) => variant.options[PACK_OPTION] === SINGLE)
    if (!single) return { kind: "skip", reason: `no ${SINGLE} variant` }
    if (!single.inr) return { kind: "skip", reason: `the ${SINGLE} variant has no INR price` }
    if (single.manage_inventory && !single.inventory.length) {
      return { kind: "skip", reason: `the ${SINGLE} variant has no inventory item` }
    }

    const amount = pairPrice(single.inr.amount)
    const pair = product.variants.find((variant) => variant.options[PACK_OPTION] === PAIR)
    if (!pair) {
      const kept = Object.fromEntries(Object.entries(single.options).filter(([title]) => title !== PACK_OPTION))
      return { kind: "apply", restructure: null, createPair: pairVariantInput(product, single, kept, amount), reprice: null }
    }
    if (pair.inr?.amount === amount) return { kind: "in_sync" }
    return {
      kind: "apply",
      restructure: null,
      createPair: null,
      reprice: { variant_id: pair.id, price_id: pair.inr?.id ?? null, amount },
    }
  }

  // No Pack option yet: only a one-variant anklet can be turned into Single and Pair.
  if (product.variants.length !== 1) {
    return { kind: "skip", reason: `${product.variants.length} variants and no ${PACK_OPTION} option` }
  }
  if (product.options.some((option) => option.title !== PLACEHOLDER_OPTION && option.values.length > 1)) {
    return { kind: "skip", reason: "it has an option with several values" }
  }

  const single = product.variants[0]
  if (!single.inr) return { kind: "skip", reason: "its variant has no INR price" }
  if (single.manage_inventory && !single.inventory.length) {
    return { kind: "skip", reason: "its variant has no inventory item" }
  }

  // Real one-value options stay; Medusa's placeholder option is replaced by Pack.
  const keptOptions = product.options.filter((option) => option.title !== PLACEHOLDER_OPTION)
  const kept = Object.fromEntries(
    Object.entries(single.options).filter(([title]) => keptOptions.some((option) => option.title === title))
  )

  return {
    kind: "apply",
    restructure: {
      options: [
        ...keptOptions.map((option) => ({ title: option.title, values: option.values })),
        { title: PACK_OPTION, values: [SINGLE, PAIR] },
      ],
      single: { id: single.id, title: SINGLE, options: { ...kept, [PACK_OPTION]: SINGLE } },
    },
    createPair: pairVariantInput(product, single, kept, pairPrice(single.inr.amount)),
    reprice: null,
  }
}
