/**
 * The launch offers and checkout charges, in one place.
 *
 * Pure functions only, so they can be tested without Medusa. Amounts are rupees
 * (Medusa major units). The setup script builds the Medusa promotions and
 * shipping options from these same tables, and the cart hook checks carts
 * against them, so the three cannot drift apart.
 */

/**
 * Added once to Cash on Delivery orders, as the COD shipping option's price. It is
 * inclusive of whatever GST applies to it, and is kept apart from the products.
 */
export const COD_CHARGE = 99

/**
 * The complimentary tote bag. It is a real product with a price of zero, so it
 * travels as an ordinary line on the cart, the order and the shipment, and its
 * stock is counted. It is never listed in the shop (hidden_from_shop).
 */
export const TOTE_SKU = "EYRA-TOTE"
export const TOTE_HANDLE = "eyra-complimentary-tote"

/**
 * Orders with items worth strictly more than this, before any discount and
 * without shipping, get a tote while stock lasts. 1,499 does not qualify; 1,500 does.
 */
export const TOTE_MIN_SUBTOTAL = 1499

/** Shipping option type codes. The storefront picks an option by these. */
export const PREPAID_OPTION_CODE = "eyra-prepaid"
export const COD_OPTION_CODE = "eyra-cod"

export const RAZORPAY_PROVIDER_ID = "pp_razorpay_razorpay"
export const COD_PROVIDER_ID = "pp_system_default"

type Bound = { value: number; inclusive: boolean }

/**
 * A code is judged on its own: the order must be worth more than `min`, with no
 * upper limit. Codes do not exclude each other by order size; only one of them
 * can be on an order at a time (see cartViolations).
 */
export type DiscountCode = {
  code: string
  /** Flat rupees off the whole order. */
  amount: number
  min: Bound
  /** Each customer account may use the code once. */
  oncePerCustomer: boolean
}

export const DISCOUNT_CODES: readonly DiscountCode[] = [
  {
    code: "WELCOME200",
    amount: 200,
    min: { value: 1499, inclusive: false },
    oncePerCustomer: true,
  },
  {
    code: "EYRA350",
    amount: 350,
    min: { value: 3000, inclusive: false },
    oncePerCustomer: false,
  },
  {
    code: "EYRA650",
    amount: 650,
    min: { value: 5000, inclusive: false },
    oncePerCustomer: false,
  },
]

export function findDiscountCode(input: string | null | undefined): DiscountCode | null {
  const code = (input ?? "").trim().toUpperCase()
  return DISCOUNT_CODES.find((entry) => entry.code === code) ?? null
}

type CartLine = {
  unit_price?: unknown
  quantity?: unknown
  variant_sku?: string | null
}

/** Whether a cart or order line is the complimentary tote bag. */
export function isToteLine(line: { variant_sku?: string | null }): boolean {
  return line.variant_sku === TOTE_SKU
}

export function qualifiesForTote(itemsSubtotal: number): boolean {
  return itemsSubtotal > TOTE_MIN_SUBTOTAL
}

/** Reads a rupee amount that may be a number, text, or Medusa's BigNumber. */
export const toNumber = (value: unknown): number => {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object") {
    const big = value as { numeric?: unknown; value?: unknown }
    if (big.numeric !== undefined) return Number(big.numeric)
    if (big.value !== undefined) return Number(big.value)
    return Number(value)
  }
  return Number.NaN
}

/**
 * What the customer is buying, before any discount and without shipping: the
 * selling price of every line times its quantity. Discounts never lower it, so
 * applying a code can never move an order into another tier. The free tote is
 * not counted, so it can never help an order qualify for itself.
 */
export function merchandiseSubtotal(lines: readonly CartLine[]): number {
  let total = 0
  for (const line of lines) {
    if (isToteLine(line)) continue
    const price = toNumber(line.unit_price)
    const quantity = toNumber(line.quantity)
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue
    total += price * quantity
  }
  return Math.round(total * 100) / 100
}

function aboveMin(subtotal: number, min: Bound): boolean {
  return min.inclusive ? subtotal >= min.value : subtotal > min.value
}

export type DiscountVerdict =
  | { ok: true }
  | { ok: false; reason: "below_minimum"; message: string }

const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`

/** Whether a code may be used on an order with this merchandise subtotal. */
export function checkDiscountEligibility(entry: DiscountCode, subtotal: number): DiscountVerdict {
  if (!aboveMin(subtotal, entry.min)) {
    const word = entry.min.inclusive ? "at least" : "above"
    return {
      ok: false,
      reason: "below_minimum",
      message: `${entry.code} needs an order ${word} ${rupees(entry.min.value)}.`,
    }
  }
  return { ok: true }
}

/** Every code that fits a subtotal. A large order fits several; the customer picks one. */
export function eligibleCodes(subtotal: number): DiscountCode[] {
  return DISCOUNT_CODES.filter((entry) => checkDiscountEligibility(entry, subtotal).ok)
}

export type PaymentMode = "prepaid" | "cod"

/**
 * How a cart will be paid, from the payment session providers on it. A cart
 * that wallet credit covers in full counts as prepaid, since nothing is
 * collected on delivery.
 */
export function paymentModeFor(providerIds: readonly string[], amountDue: number): PaymentMode | null {
  if (providerIds.includes(RAZORPAY_PROVIDER_ID)) return "prepaid"
  if (providerIds.includes(COD_PROVIDER_ID)) return amountDue > 0 ? "cod" : "prepaid"
  return null
}

export function optionCodeFor(mode: PaymentMode): string {
  return mode === "cod" ? COD_OPTION_CODE : PREPAID_OPTION_CODE
}

export type CartFacts = {
  lines: readonly CartLine[]
  /** Type codes of the selected shipping options. */
  shippingOptionCodes: readonly string[]
  paymentProviderIds: readonly string[]
  /** What is left to pay after wallet credit. */
  amountDue: number
  promoCodes: readonly string[]
}

/** Everything wrong with a cart that is about to become an order. Empty is fine. */
export function cartViolations(facts: CartFacts): string[] {
  const problems: string[] = []
  const subtotal = merchandiseSubtotal(facts.lines)

  // The tote only goes to qualifying orders, one per order. A qualifying order
  // may have none, since the tote is subject to stock.
  const toteUnits = facts.lines
    .filter(isToteLine)
    .reduce((sum, line) => sum + (Number(toNumber(line.quantity)) || 0), 0)
  if (toteUnits > 1) {
    problems.push("Only one complimentary tote bag can be added to an order.")
  } else if (toteUnits === 1 && !qualifiesForTote(subtotal)) {
    problems.push(`The complimentary tote bag is for orders above ₹${TOTE_MIN_SUBTOTAL.toLocaleString("en-IN")}.`)
  }

  if (facts.promoCodes.length > 1) {
    problems.push("Only one discount code can be used on an order.")
  }
  for (const code of facts.promoCodes) {
    const entry = findDiscountCode(code)
    if (!entry) continue
    const verdict = checkDiscountEligibility(entry, subtotal)
    if (!verdict.ok) problems.push(verdict.message)
  }

  const mode = paymentModeFor(facts.paymentProviderIds, facts.amountDue)
  if (mode) {
    const expected = optionCodeFor(mode)
    const matching = facts.shippingOptionCodes.filter((code) => code === expected)
    if (facts.shippingOptionCodes.length !== 1 || matching.length !== 1) {
      problems.push(
        mode === "cod"
          ? "Cash on Delivery orders must carry the Cash on Delivery charge."
          : "Prepaid orders must use complimentary shipping."
      )
    }
  }

  return problems
}
