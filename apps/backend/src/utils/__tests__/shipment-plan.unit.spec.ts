import { planShipment } from "../../workflows/steps/build-shipment-request"

const address = {
  first_name: "Asha", last_name: "Rao", address_1: "12 Lake Road", address_2: null, city: "Pune",
  province: "Maharashtra", postal_code: "411001", phone: "9999999999",
}

const order = (items: any[], extra: Record<string, unknown> = {}) => ({
  id: "order_1", display_id: 21, email: "asha@example.com", status: "pending", canceled_at: null,
  total: 2099, discount_total: 0, shipping_total: 99, metadata: {}, items, shipping_address: address,
  payment_collections: [], credit_lines: [], ...extra,
})

describe("shipment plan", () => {
  it("lists the complimentary tote on the packing list at a price of zero", () => {
    const plan = planShipment(
      order([
        { title: "Ring", product_title: "Ring", variant_sku: "RING-1", product_type: "ring", unit_price: 2000, quantity: 1 },
        { title: "EYRA Tote Bag", product_title: "EYRA Tote Bag", variant_sku: "EYRA-TOTE", unit_price: 0, quantity: 1 },
      ]) as any
    )
    expect(plan.action).toBe("ship")
    if (plan.action !== "ship") return
    expect(plan.request.items.map((i) => [i.sku, i.price, i.complimentary])).toEqual([
      ["RING-1", 2000, false],
      ["EYRA-TOTE", 0, true],
    ])
    // The courier collects what the customer owes: the tote adds nothing to it.
    expect(plan.request.subtotal).toBe(2099)
    expect(plan.request.paymentMethod).toBe("cod")
  })

  it("sends a replacement for an exchange as prepaid: the courier collects nothing", () => {
    const plan = planShipment(
      order(
        [{ title: "Ring", product_title: "Ring", variant_sku: "RING-2", product_type: "ring", unit_price: 2500, quantity: 1 }],
        { total: 2500, shipping_total: 0, metadata: { replacement_for_order: "order_original" } }
      ) as any
    )
    expect(plan.action).toBe("ship")
    if (plan.action !== "ship") return
    expect(plan.request.paymentMethod).toBe("prepaid")
  })

  it("sends an ordinary unpaid order as Cash on Delivery", () => {
    const plan = planShipment(
      order([{ title: "Ring", product_title: "Ring", variant_sku: "RING-2", product_type: "ring", unit_price: 2500, quantity: 1 }], { total: 2599 }) as any
    )
    if (plan.action !== "ship") throw new Error("expected a shipment")
    expect(plan.request.paymentMethod).toBe("cod")
  })
})
