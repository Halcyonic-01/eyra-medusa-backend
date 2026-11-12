import {
  cartPriceRequests,
  findStalePriceLines,
  repriceableLines,
  stalePriceMessage,
  type CartForPricing,
} from "../stale-prices"

const big = (n: number) => ({ numeric_: n, raw_: { value: String(n), precision: 20 }, bignumber_: {}, numeric: n })

const cart = (items: CartForPricing["items"]): CartForPricing => ({
  id: "cart_1",
  currency_code: "inr",
  region_id: "reg_in",
  customer_id: "cus_1",
  email: "a@example.com",
  sales_channel_id: "sc_1",
  region: { currency_code: "inr" },
  customer: { id: "cus_1", groups: [{ id: "cg_vip" }] },
  items,
})

const anklet = { id: "item_a", title: "Luna Anklet", variant_id: "var_a", quantity: 1, unit_price: 1800 }
const pair = { id: "item_b", title: "Luna Anklet Pair", variant_id: "var_b", quantity: 2, unit_price: 3400 }

describe("repriceableLines", () => {
  it("skips custom priced lines, lines without a variant and empty slots", () => {
    const lines = repriceableLines(
      cart([
        anklet,
        { id: "item_c", title: "Custom", variant_id: "var_c", unit_price: 10, is_custom_price: true },
        { id: "item_d", title: "Loose", variant_id: null, unit_price: 10 },
        null,
      ])
    )
    expect(lines.map((line) => line.id)).toEqual(["item_a"])
  })
})

describe("cartPriceRequests", () => {
  it("prices each line with the cart's region, currency, customer and its own quantity", () => {
    const [first, second] = cartPriceRequests(cart([anklet, pair]))
    expect(first).toMatchObject({ id: "item_a", variantId: "var_a" })
    expect(first.context).toMatchObject({
      currency_code: "inr",
      region_id: "reg_in",
      customer_id: "cus_1",
      quantity: 1,
      customer: { id: "cus_1", groups: [{ id: "cg_vip" }] },
    })
    expect(second.context.quantity).toBe(2)
  })

  it("falls back to the region currency and reads BigNumber quantities", () => {
    const [request] = cartPriceRequests({
      ...cart([{ ...anklet, quantity: big(3) }]),
      currency_code: null,
    })
    expect(request.context.currency_code).toBe("inr")
    expect(request.context.quantity).toBe(3)
  })
})

describe("findStalePriceLines", () => {
  it("returns nothing when every line matches today's price", () => {
    const stale = findStalePriceLines(cart([anklet, pair]), {
      item_a: { calculated_amount: 1800 },
      item_b: { calculated_amount: big(3400) },
    })
    expect(stale).toEqual([])
  })

  it("flags a line whose sale ended (price went up)", () => {
    const stale = findStalePriceLines(cart([anklet, pair]), {
      item_a: { calculated_amount: 2880 },
      item_b: { calculated_amount: 3400 },
    })
    expect(stale).toEqual([{ id: "item_a", title: "Luna Anklet", unit_price: 1800, current_price: 2880 }])
  })

  it("flags a price that went down", () => {
    const stale = findStalePriceLines(cart([{ ...pair, unit_price: big(3400) }]), {
      item_b: { calculated_amount: 3000 },
    })
    expect(stale[0]).toMatchObject({ unit_price: 3400, current_price: 3000 })
  })

  it("ignores differences smaller than half a paisa", () => {
    expect(findStalePriceLines(cart([anklet]), { item_a: { calculated_amount: 1800.004 } })).toEqual([])
    expect(findStalePriceLines(cart([anklet]), { item_a: { calculated_amount: 1800.01 } })).toHaveLength(1)
  })

  it("flags a line whose variant has no current price", () => {
    const stale = findStalePriceLines(cart([anklet]), { item_a: { calculated_amount: null } })
    expect(stale).toEqual([{ id: "item_a", title: "Luna Anklet", unit_price: 1800, current_price: null }])
    expect(findStalePriceLines(cart([anklet]), {})).toHaveLength(1)
  })

  it("never flags custom priced lines", () => {
    const custom = { ...anklet, is_custom_price: true }
    expect(findStalePriceLines(cart([custom]), { item_a: { calculated_amount: 9999 } })).toEqual([])
  })
})

describe("stalePriceMessage", () => {
  it("names each changed line with old and new price", () => {
    const message = stalePriceMessage([
      { id: "item_a", title: "Luna Anklet", unit_price: 1800, current_price: 2880 },
      { id: "item_b", title: "Moonstone Pendant", unit_price: 1200, current_price: null },
    ])
    expect(message).toBe(
      "Prices in your cart have changed: Luna Anklet is now ₹2,880 (was ₹1,800); " +
        "Moonstone Pendant can no longer be bought. Please review your cart and try again."
    )
  })
})
