import { plainInrPrice, unitsAvailable } from "../replacement"

const stock = (stocked: number, reserved: number, required = 1) => ({
  required_quantity: required,
  inventory: { location_levels: [{ stocked_quantity: stocked, reserved_quantity: reserved }] },
})

describe("unitsAvailable", () => {
  it("counts an anklet Pair as two of its stock", () => {
    expect(unitsAvailable({ id: "pair", inventory_items: [stock(5, 0, 2)] })).toBe(2)
    expect(unitsAvailable({ id: "pair", inventory_items: [stock(3, 2, 2)] })).toBe(0)
  })

  it("counts any other variant piece by piece, as before", () => {
    expect(unitsAvailable({ id: "ring", inventory_items: [stock(5, 2)] })).toBe(3)
    expect(unitsAvailable({ id: "none", inventory_items: [] })).toBe(0)
    expect(unitsAvailable({ id: "free", manage_inventory: false })).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("plainInrPrice", () => {
  it("takes the normal price, never a sale price-list price", () => {
    const variant = {
      id: "v",
      price_set: {
        prices: [
          { amount: 1200, currency_code: "inr", rules_count: 0, price_list_id: "plist_sale" },
          { amount: 1500, currency_code: "inr", rules_count: 0, price_list_id: null },
        ],
      },
    }
    expect(plainInrPrice(variant)).toBe(1500)
  })
})
