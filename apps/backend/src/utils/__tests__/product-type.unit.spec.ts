import { shipmentItemType } from "../product-type"

describe("shipmentItemType", () => {
  it("turns the names in the production admin into the weight table's keys", () => {
    expect(shipmentItemType("Rings")).toBe("ring")
    expect(shipmentItemType("Pendants")).toBe("pendant")
    expect(shipmentItemType("Anklets")).toBe("anklet")
    expect(shipmentItemType("Bracelets")).toBe("bracelet")
  })

  it("does not care about capital letters, spaces or a plural", () => {
    expect(shipmentItemType("ring")).toBe("ring")
    expect(shipmentItemType("RING")).toBe("ring")
    expect(shipmentItemType("  Chains ")).toBe("chain")
    expect(shipmentItemType("Earrings")).toBe("earring")
  })

  it("weighs necklaces like chains and bangles like bracelets", () => {
    expect(shipmentItemType("Necklaces")).toBe("chain")
    expect(shipmentItemType("Bangles")).toBe("bracelet")
  })

  it("keeps a name it does not know, in lower case, so the storefront uses its default weight", () => {
    expect(shipmentItemType("Charms")).toBe("charm")
    expect(shipmentItemType("Cufflinks")).toBe("cufflink")
  })

  it("falls back to ring when the product has no type", () => {
    expect(shipmentItemType(null)).toBe("ring")
    expect(shipmentItemType(undefined)).toBe("ring")
    expect(shipmentItemType("")).toBe("ring")
    expect(shipmentItemType("   ")).toBe("ring")
  })
})
