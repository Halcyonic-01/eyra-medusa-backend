import { shipmentItemType } from "./product-type"

/**
 * Every anklet is sold as a Single or a Pair. The admin only sets the Single
 * price; the Pair is its own variant, kept by the backend at two singles less a
 * fixed amount, and it draws two units from the Single's stock. Quantity counts
 * units of the chosen option: two Pairs are four anklets at two pair prices.
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
  /** INR prices in price lists (sales), without rules of their own. */
  listPrices: { id: string; price_list_id: string; amount: number }[]
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
      /** Give the Pair a price in every price list the Single is in (a sale), at two sale singles less the discount. */
      listPrices: {
        price_list_id: string
        create: { variant_id: string; amount: number; currency_code: string }[]
        update: { id: string; variant_id: string; amount: number; currency_code: string }[]
        delete: string[]
      }[]
      /** Make the Pair draw two of each of the Single's stock items, and nothing else. */
      relink: {
        variant_id: string
        create: { inventory_item_id: string; required_quantity: number }[]
        update: { inventory_item_id: string; required_quantity: number }[]
        delete: string[]
      } | null
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

/**
 * The Pair's sale prices: in each price list holding a price for the Single,
 * the Pair costs two of those singles less the discount, so a sale and the pair
 * discount add up and both end together. Pair prices in lists the Single has
 * left are removed. A new Pair gets its sale prices on the next sync.
 */
function planListPrices(single: PairVariant, pair: PairVariant): Extract<PairPlan, { kind: "apply" }>["listPrices"] {
  const lists = new Set([...single.listPrices, ...pair.listPrices].map((price) => price.price_list_id))
  const changes: Extract<PairPlan, { kind: "apply" }>["listPrices"] = []
  for (const listId of lists) {
    const sale = single.listPrices.find((price) => price.price_list_id === listId)
    const current = pair.listPrices.filter((price) => price.price_list_id === listId)
    const change = { price_list_id: listId, create: [], update: [], delete: [] } as (typeof changes)[number]
    if (!sale) {
      change.delete = current.map((price) => price.id)
    } else {
      const amount = pairPrice(sale.amount)
      const [keep, ...extra] = current
      if (!keep) change.create = [{ variant_id: pair.id, amount, currency_code: "inr" }]
      else if (keep.amount !== amount) change.update = [{ id: keep.id, variant_id: pair.id, amount, currency_code: "inr" }]
      change.delete = extra.map((price) => price.id)
    }
    if (change.create.length || change.update.length || change.delete.length) changes.push(change)
  }
  return changes
}

/**
 * The stock links that make a Pair take two of each of the Single's items, or
 * null when it already does. A Pair set up with its own stock item is moved
 * onto the Single's; the old item is only unlinked, never deleted.
 */
function planRelink(single: PairVariant, pair: PairVariant): Extract<PairPlan, { kind: "apply" }>["relink"] {
  if (!single.manage_inventory || !pair.manage_inventory || !single.inventory.length) return null
  const wanted = new Map(single.inventory.map((item) => [item.inventory_item_id, item.required_quantity * 2]))
  const have = new Map(pair.inventory.map((item) => [item.inventory_item_id, item.required_quantity]))

  const create = [...wanted].filter(([id]) => !have.has(id))
  const update = [...wanted].filter(([id, quantity]) => have.has(id) && have.get(id) !== quantity)
  const remove = [...have.keys()].filter((id) => !wanted.has(id))
  if (!create.length && !update.length && !remove.length) return null

  const link = ([inventory_item_id, required_quantity]: [string, number]) => ({ inventory_item_id, required_quantity })
  return { variant_id: pair.id, create: create.map(link), update: update.map(link), delete: remove }
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
      return {
        kind: "apply",
        restructure: null,
        createPair: pairVariantInput(product, single, kept, amount),
        reprice: null,
        listPrices: [],
        relink: null,
      }
    }
    const reprice = pair.inr?.amount === amount ? null : { variant_id: pair.id, price_id: pair.inr?.id ?? null, amount }
    const listPrices = planListPrices(single, pair)
    const relink = planRelink(single, pair)
    if (!reprice && !listPrices.length && !relink) return { kind: "in_sync" }
    return { kind: "apply", restructure: null, createPair: null, reprice, listPrices, relink }
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
    listPrices: [],
    relink: null,
  }
}
