import { sharedStockShortfalls, type StockVariant } from "../shared-stock"

const anklet = (available: number): StockVariant[] => [
  {
    id: "single",
    product_title: "Luna Anklet",
    manage_inventory: true,
    allow_backorder: false,
    items: [{ inventory_item_id: "iitem_luna", required_quantity: 1, available }],
  },
  {
    id: "pair",
    product_title: "Luna Anklet",
    manage_inventory: true,
    allow_backorder: false,
    items: [{ inventory_item_id: "iitem_luna", required_quantity: 2, available }],
  },
]

describe("sharedStockShortfalls", () => {
  it("adds a Pair's two anklets to the Singles drawn from the same stock", () => {
    expect(sharedStockShortfalls([{ variant_id: "pair", quantity: 2 }, { variant_id: "single", quantity: 1 }], anklet(5))).toEqual([])
    expect(sharedStockShortfalls([{ variant_id: "pair", quantity: 2 }, { variant_id: "single", quantity: 2 }], anklet(5))).toEqual([
      "Only 5 of Luna Anklet are in stock, and a pair counts as 2.",
    ])
  })

  it("leaves a line that shares stock with no other line to Medusa", () => {
    expect(sharedStockShortfalls([{ variant_id: "pair", quantity: 3 }], anklet(5))).toEqual([])
  })

  it("ignores variants that do not track stock or allow backorders", () => {
    const variants = anklet(1).map((variant) => ({ ...variant, allow_backorder: true }))
    expect(sharedStockShortfalls([{ variant_id: "pair", quantity: 2 }, { variant_id: "single", quantity: 2 }], variants)).toEqual([])
  })

  it("never links two products with their own stock", () => {
    const ring = (id: string): StockVariant => ({
      id,
      product_title: id,
      manage_inventory: true,
      allow_backorder: false,
      items: [{ inventory_item_id: `iitem_${id}`, required_quantity: 1, available: 1 }],
    })
    expect(sharedStockShortfalls([{ variant_id: "a", quantity: 1 }, { variant_id: "b", quantity: 1 }], [ring("a"), ring("b")])).toEqual([])
  })
})
