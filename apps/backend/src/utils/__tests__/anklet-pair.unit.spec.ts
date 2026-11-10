import { isAnkletType, pairPrice, planPairSync, type PairProduct, type PairVariant } from "../anklet-pair"

const variant = (over: Partial<PairVariant> = {}): PairVariant => ({
  id: "variant_single",
  title: "The Crystal Floral Anklet",
  sku: "crystal-floral",
  manage_inventory: true,
  options: { "Default option": "Default option value" },
  inr: { id: "price_single", amount: 1500 },
  inventory: [{ inventory_item_id: "iitem_1", required_quantity: 1 }],
  ...over,
})

// How an anklet created in the admin looks: one variant under Medusa's placeholder option.
const fresh = (over: Partial<PairProduct> = {}): PairProduct => ({
  id: "prod_1",
  type: "Anklets",
  options: [{ title: "Default option", values: ["Default option value"] }],
  variants: [variant()],
  ...over,
})

const packed = (pairAmount: number | null): PairProduct => ({
  id: "prod_1",
  type: "anklet",
  options: [{ title: "Pack", values: ["Single", "Pair"] }],
  variants: [
    variant({ title: "Single", options: { Pack: "Single" } }),
    ...(pairAmount === null
      ? []
      : [
          variant({
            id: "variant_pair",
            title: "Pair",
            sku: "crystal-floral-pair",
            options: { Pack: "Pair" },
            inr: { id: "price_pair", amount: pairAmount },
            inventory: [{ inventory_item_id: "iitem_1", required_quantity: 2 }],
          }),
        ]),
  ],
})

describe("pairPrice", () => {
  it("is two singles less 200", () => {
    expect(pairPrice(1500)).toBe(2800)
    expect(pairPrice(1399)).toBe(2598)
  })

  it("never goes below zero", () => {
    expect(pairPrice(50)).toBe(0)
  })
})

describe("isAnkletType", () => {
  it("knows the admin's type names", () => {
    expect(isAnkletType("Anklets")).toBe(true)
    expect(isAnkletType("anklet")).toBe(true)
    expect(isAnkletType("Rings")).toBe(false)
    expect(isAnkletType(null)).toBe(false)
    expect(isAnkletType("")).toBe(false)
  })
})

describe("planPairSync", () => {
  it("leaves anything that is not an anklet alone", () => {
    expect(planPairSync(fresh({ type: "Rings" }))).toEqual({ kind: "skip", reason: "not an anklet" })
  })

  it("turns a new one-variant anklet into Single and Pair, the pair taking two of the single's stock", () => {
    const plan = planPairSync(fresh())
    expect(plan).toEqual({
      kind: "apply",
      restructure: {
        options: [{ title: "Pack", values: ["Single", "Pair"] }],
        single: { id: "variant_single", title: "Single", options: { Pack: "Single" } },
      },
      createPair: {
        product_id: "prod_1",
        title: "Pair",
        sku: "crystal-floral-pair",
        manage_inventory: true,
        options: { Pack: "Pair" },
        prices: [{ amount: 2800, currency_code: "inr" }],
        inventory_items: [{ inventory_item_id: "iitem_1", required_quantity: 2 }],
      },
      reprice: null,
    })
  })

  it("keeps a real one-value option on both variants", () => {
    const plan = planPairSync(
      fresh({
        options: [{ title: "Metal", values: ["925 Silver"] }],
        variants: [variant({ options: { Metal: "925 Silver" } })],
      })
    )
    expect(plan.kind).toBe("apply")
    if (plan.kind !== "apply") return
    expect(plan.restructure?.options).toEqual([
      { title: "Metal", values: ["925 Silver"] },
      { title: "Pack", values: ["Single", "Pair"] },
    ])
    expect(plan.restructure?.single.options).toEqual({ Metal: "925 Silver", Pack: "Single" })
    expect(plan.createPair?.options).toEqual({ Metal: "925 Silver", Pack: "Pair" })
  })

  it("does not stock the pair when the single is not stock-managed", () => {
    const plan = planPairSync(fresh({ variants: [variant({ manage_inventory: false, inventory: [] })] }))
    expect(plan.kind === "apply" && plan.createPair).toMatchObject({ manage_inventory: false })
    expect(plan.kind === "apply" && plan.createPair && "inventory_items" in plan.createPair).toBe(false)
  })

  it("adds a missing Pair to an anklet that already has the Pack option", () => {
    const plan = planPairSync(packed(null))
    expect(plan.kind === "apply" && plan.restructure).toBe(null)
    expect(plan.kind === "apply" && plan.createPair?.prices).toEqual([{ amount: 2800, currency_code: "inr" }])
  })

  it("reprices a Pair that no longer follows the Single", () => {
    expect(planPairSync(packed(3000))).toEqual({
      kind: "apply",
      restructure: null,
      createPair: null,
      reprice: { variant_id: "variant_pair", price_id: "price_pair", amount: 2800 },
    })
  })

  it("does nothing when the Pair price is already right", () => {
    expect(planPairSync(packed(2800))).toEqual({ kind: "in_sync" })
  })

  it("does not guess with several variants and no Pack option", () => {
    const plan = planPairSync(fresh({ variants: [variant(), variant({ id: "variant_2" })] }))
    expect(plan).toEqual({ kind: "skip", reason: "2 variants and no Pack option" })
  })

  it("does not price a Pair from a Single without an INR price", () => {
    expect(planPairSync(fresh({ variants: [variant({ inr: null })] })).kind).toBe("skip")
  })
})
