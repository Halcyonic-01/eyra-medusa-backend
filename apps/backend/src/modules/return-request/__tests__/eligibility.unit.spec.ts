import { deliveryStateOf, returnWindowEnds, withinReturnWindow } from "../eligibility"
import { paidValueOf, paidValues } from "../pricing"

describe("delivery state", () => {
  it("uses the dispatch record's delivery time", () => {
    const at = new Date("2026-10-20T09:00:00Z")
    expect(deliveryStateOf({ delivered_at: at }, {})).toEqual({ kind: "delivered", at })
  })

  it("falls back to the order's tracking keys when the record has nothing", () => {
    expect(deliveryStateOf(null, { shiprocket_status: "DELIVERED", shiprocket_status_updated_at: "2026-10-20T09:00:00.000Z" })).toEqual({
      kind: "delivered",
      at: new Date("2026-10-20T09:00:00.000Z"),
    })
  })

  it("is unknown when delivered but with no date, and when nothing is known", () => {
    expect(deliveryStateOf(null, { shiprocket_status: "DELIVERED" }).kind).toBe("unknown")
    expect(deliveryStateOf(null, {}).kind).toBe("unknown")
    expect(deliveryStateOf(null, null).kind).toBe("unknown")
  })

  it("is in transit for any other courier status, and returning for RTO", () => {
    expect(deliveryStateOf({ shiprocket_status: "IN TRANSIT" }, {}).kind).toBe("in_transit")
    expect(deliveryStateOf({ shiprocket_status: "OUT FOR DELIVERY" }, {}).kind).toBe("in_transit")
    expect(deliveryStateOf({ shiprocket_status: "RTO IN TRANSIT" }, {}).kind).toBe("returning")
    expect(deliveryStateOf({ rto_initiated_at: new Date(), delivered_at: new Date() }, {}).kind).toBe("returning")
  })
})

describe("the 7-day window", () => {
  const delivered = new Date("2026-10-10T08:00:00Z")

  it("runs 7 days from delivery, to the moment", () => {
    expect(returnWindowEnds(delivered).toISOString()).toBe("2026-10-17T08:00:00.000Z")
    expect(withinReturnWindow(delivered, new Date("2026-10-17T08:00:00Z"))).toBe(true)
    expect(withinReturnWindow(delivered, new Date("2026-10-17T08:00:01Z"))).toBe(false)
  })

  it("is open on the day of delivery", () => {
    expect(withinReturnWindow(delivered, new Date("2026-10-10T08:05:00Z"))).toBe(true)
  })
})

describe("what was paid for a line", () => {
  it("takes each line's share of the discount: 200 off 1,500 and 1,000", () => {
    const paid = paidValues(
      [
        { item_id: "a", unit_price: 1500, quantity: 1 },
        { item_id: "b", unit_price: 1000, quantity: 1 },
      ],
      200
    )
    expect(paid.get("a")).toBe(138000)
    expect(paid.get("b")).toBe(92000)
  })

  it("a line returned in part is taken in proportion; the whole line is exact", () => {
    expect(paidValueOf(290000, 3, 1)).toBe(966.67)
    expect(paidValueOf(290000, 3, 3)).toBe(2900)
  })
})
