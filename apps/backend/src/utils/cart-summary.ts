import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  COD_OPTION_CODE,
  PREPAID_OPTION_CODE,
  isToteLine,
  merchandiseSubtotal,
  qualifiesForTote,
  toNumber,
  type PaymentMode,
} from "./commerce-rules"

const num = (value: unknown): number => {
  const parsed = toNumber(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The cart fields the commerce rules read. Shipping methods must be loaded or totals leave shipping out. */
export const CART_RULE_FIELDS = [
  "id",
  "currency_code",
  "email",
  "customer_id",
  "completed_at",
  "total",
  "item_subtotal",
  "discount_total",
  "tax_total",
  "shipping_total",
  "items.*",
  "shipping_methods.*",
  "shipping_methods.shipping_option.type.code",
  "promotions.code",
  "credit_lines.*",
]

export type CartSummary = {
  id: string
  email: string | null
  customer_id: string | null
  /** True once the cart has become an order. */
  completed: boolean
  items: {
    id: string
    variant_id: string | null
    product_id: string | null
    product_handle: string | null
    title: string
    product_title: string | null
    variant_title: string | null
    quantity: number
    unit_price: number
    subtotal: number
    thumbnail: string | null
    /** True for the free tote bag: not for the customer to change or remove. */
    complimentary: boolean
  }[]
  totals: {
    /** Price of the items before any discount, without shipping. */
    items_subtotal: number
    discount_total: number
    tax_total: number
    /** Shipping charge: 0 for prepaid, the Cash on Delivery charge for COD. */
    shipping_total: number
    wallet_credit: number
    total: number
  }
  promo_codes: string[]
  payment_mode: PaymentMode | null
  /** Whether the items qualify for the complimentary tote, and whether it is in the cart. */
  tote: { qualifies: boolean; in_cart: boolean }
}

type Amount = number | string | { numeric?: number; value?: string | number } | null | undefined

/** The cart as read for the rules. Query results are loosely typed, so they are narrowed to this. */
export type CartForRules = {
  id: string
  email?: string | null
  customer_id?: string | null
  completed_at?: string | Date | null
  total?: Amount
  tax_total?: Amount
  discount_total?: Amount
  shipping_total?: Amount
  items?: ({
    id: string
    variant_id?: string | null
    product_id?: string | null
    product_handle?: string | null
    title: string
    product_title?: string | null
    variant_title?: string | null
    variant_sku?: string | null
    quantity?: Amount
    unit_price?: Amount
    subtotal?: Amount
    thumbnail?: string | null
  } | null)[]
  shipping_methods?: ({ shipping_option?: { type?: { code?: string | null } | null } | null } | null)[]
  promotions?: ({ code?: string | null } | null)[]
  credit_lines?: ({ amount?: Amount } | null)[]
}

export async function loadCartForRules(container: MedusaContainer, cartId: string): Promise<CartForRules | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: CART_RULE_FIELDS,
    filters: { id: cartId },
  })
  return (data[0] as unknown as CartForRules | undefined) ?? null
}

export type CartLineRecord = NonNullable<NonNullable<CartForRules["items"]>[number]>

/** The cart's real line items, without the empty slots a query can leave. */
export function cartLines(cart: CartForRules): CartLineRecord[] {
  return (cart.items ?? []).filter((line): line is CartLineRecord => Boolean(line))
}

type RawCart = CartForRules

export function summarizeCart(cart: RawCart): CartSummary {
  const lines = cartLines(cart)
  const optionCodes = (cart.shipping_methods ?? [])
    .map((method) => method?.shipping_option?.type?.code)
    .filter(Boolean) as string[]

  const mode: PaymentMode | null = optionCodes.includes(COD_OPTION_CODE)
    ? "cod"
    : optionCodes.includes(PREPAID_OPTION_CODE)
    ? "prepaid"
    : null

  const items = lines.map((line) => ({
    id: line.id,
    variant_id: line.variant_id ?? null,
    product_id: line.product_id ?? null,
    product_handle: line.product_handle ?? null,
    title: line.title,
    product_title: line.product_title ?? null,
    variant_title: line.variant_title ?? null,
    quantity: num(line.quantity),
    unit_price: num(line.unit_price),
    subtotal: num(line.subtotal),
    thumbnail: line.thumbnail ?? null,
    complimentary: isToteLine(line),
  }))

  const subtotal = merchandiseSubtotal(lines)

  return {
    id: cart.id,
    email: cart.email ?? null,
    customer_id: cart.customer_id ?? null,
    completed: Boolean(cart.completed_at),
    items,
    totals: {
      items_subtotal: subtotal,
      discount_total: num(cart.discount_total),
      tax_total: num(cart.tax_total),
      shipping_total: num(cart.shipping_total),
      wallet_credit: (cart.credit_lines ?? []).reduce((sum, credit) => sum + num(credit?.amount), 0),
      total: num(cart.total),
    },
    promo_codes: (cart.promotions ?? []).map((promotion) => promotion?.code).filter(Boolean) as string[],
    payment_mode: mode,
    tote: { qualifies: qualifiesForTote(subtotal), in_cart: lines.some(isToteLine) },
  }
}

export async function loadCartSummary(container: MedusaContainer, cartId: string): Promise<CartSummary | null> {
  const cart = await loadCartForRules(container, cartId)
  return cart ? summarizeCart(cart) : null
}
