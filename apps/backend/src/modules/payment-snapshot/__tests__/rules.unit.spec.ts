import {
  RAZORPAY_PROVIDER_ID,
  buildSnapshot,
  judgePaidSnapshot,
  paidTowardsOrder,
  snapshotLines,
  snapshotMatchesCart,
  toPaise,
  type CartLike,
  type PaymentSnapshotRecord,
  type RazorpayOrder,
  type RazorpayPayment,
  type SessionLike,
} from "../rules"

const big = (n: number) => ({ numeric_: n, raw_: { value: String(n), precision: 20 }, bignumber_: {}, numeric: n })

// A cart built during a sale: the anklet at ₹1,000 (regular ₹2,000) and the free tote.
const saleCart = (): CartLike => ({
  id: "cart_1",
  currency_code: "inr",
  total: big(1000),
  items: [
    { id: "item_b", variant_id: "var_tote", quantity: 1, unit_price: 0 },
    { id: "item_a", variant_id: "var_anklet", quantity: big(1), unit_price: big(1000) },
  ],
})

const session = (over: Partial<SessionLike> = {}): SessionLike => ({
  id: "payses_1",
  provider_id: RAZORPAY_PROVIDER_ID,
  status: "pending",
  amount: big(1000),
  currency_code: "inr",
  data: { razorpayOrder: { id: "order_1", amount: 100000, currency: "INR" } },
  ...over,
})

const snapshotOf = (cart = saleCart(), s = session()): PaymentSnapshotRecord => {
  const built = buildSnapshot(cart, s, "paycol_1")
  if (!built.ok) throw new Error(built.message)
  return built.snapshot
}

const order = (over: Partial<RazorpayOrder> = {}): RazorpayOrder => ({
  id: "order_1",
  amount: 100000,
  currency: "INR",
  status: "paid",
  ...over,
})

const payment = (over: Partial<RazorpayPayment> = {}): RazorpayPayment => ({
  id: "pay_1",
  order_id: "order_1",
  amount: 100000,
  currency: "INR",
  status: "captured",
  ...over,
})

describe("toPaise", () => {
  it("reads numbers, text and BigNumber, rounding to the paisa", () => {
    expect(toPaise(1000)).toBe(100000)
    expect(toPaise("19.99")).toBe(1999)
    expect(toPaise(big(2099.5))).toBe(209950)
    expect(Number.isNaN(toPaise(undefined))).toBe(true)
  })
})

describe("buildSnapshot", () => {
  it("records every line sorted by id, in paise, with the agreed amount", () => {
    const snapshot = snapshotOf()
    expect(snapshot).toMatchObject({
      cart_id: "cart_1",
      payment_collection_id: "paycol_1",
      payment_session_id: "payses_1",
      razorpay_order_id: "order_1",
      currency_code: "inr",
      amount_paise: 100000,
      razorpay_amount_paise: 100000,
    })
    expect(snapshot.lines.map((line) => line.id)).toEqual(["item_a", "item_b"])
    expect(snapshot.lines[0]).toEqual({ id: "item_a", variant_id: "var_anklet", quantity: 1, unit_price_paise: 100000 })
  })

  it("refuses when the Razorpay order amount differs from the session (amount mismatch)", () => {
    const built = buildSnapshot(saleCart(), session({ data: { razorpayOrder: { id: "order_1", amount: 99900 } } }), "paycol_1")
    expect(built.ok).toBe(false)
  })

  it("refuses when the session amount differs from the cart total", () => {
    expect(buildSnapshot(saleCart(), session({ amount: 900 }), "paycol_1").ok).toBe(false)
  })

  it("refuses a session that is not Razorpay or has no Razorpay order", () => {
    expect(buildSnapshot(saleCart(), session({ provider_id: "pp_system_default" }), "paycol_1").ok).toBe(false)
    expect(buildSnapshot(saleCart(), session({ data: {} }), "paycol_1").ok).toBe(false)
  })

  it("refuses a zero amount", () => {
    const free = { ...saleCart(), total: 0 }
    expect(buildSnapshot(free, session({ amount: 0, data: { razorpayOrder: { id: "order_1", amount: 0 } } }), "paycol_1").ok).toBe(false)
  })
})

describe("paidTowardsOrder", () => {
  it("counts captured and authorized payments for this order only", () => {
    const paid = paidTowardsOrder(order(), [
      payment({ id: "pay_1", amount: 60000 }),
      payment({ id: "pay_2", amount: 40000, status: "authorized" }),
      payment({ id: "pay_3", status: "failed" }),
      payment({ id: "pay_4", status: "refunded" }),
      payment({ id: "pay_5", order_id: "order_other" }),
      payment({ id: "pay_6", currency: "USD" }),
    ])
    expect(paid).toBe(100000)
  })
})

describe("snapshotMatchesCart", () => {
  it("matches the same cart and session", () => {
    expect(snapshotMatchesCart(snapshotOf(), saleCart(), session())).toEqual({ honoured: true })
  })

  it("has nothing to match without a snapshot (COD, wallet-only, or a session opened elsewhere)", () => {
    expect(snapshotMatchesCart(null, saleCart(), session())).toEqual({ honoured: false, reason: "no_snapshot" })
  })

  it("treats a new payment attempt as a different session", () => {
    const retry = session({ id: "payses_2", data: { razorpayOrder: { id: "order_2", amount: 100000 } } })
    expect(snapshotMatchesCart(snapshotOf(), saleCart(), retry)).toMatchObject({ reason: "session_changed" })
  })

  it("notices a swapped Razorpay order on the same session", () => {
    const swapped = session({ data: { razorpayOrder: { id: "order_x", amount: 100000 } } })
    expect(snapshotMatchesCart(snapshotOf(), saleCart(), swapped)).toMatchObject({ reason: "session_changed" })
  })

  it("notices a cart that changed after the payment opened", () => {
    const more = saleCart()
    more.items = [...(more.items ?? []), { id: "item_c", variant_id: "var_ring", quantity: 1, unit_price: 0 }]
    expect(snapshotMatchesCart(snapshotOf(), more, session())).toMatchObject({ reason: "cart_changed" })

    const qty = saleCart()
    qty.items = qty.items!.map((line) => (line?.id === "item_a" ? { ...line, quantity: 2 } : line))
    expect(snapshotMatchesCart(snapshotOf(), qty, session())).toMatchObject({ reason: "cart_changed" })
  })

  it("notices a total that no longer matches the snapshot", () => {
    expect(snapshotMatchesCart(snapshotOf(), { ...saleCart(), total: 2000 }, session())).toMatchObject({
      reason: "amount_mismatch",
    })
  })
})

describe("judgePaidSnapshot", () => {
  const judge = (over: Partial<Parameters<typeof judgePaidSnapshot>[0]> = {}) =>
    judgePaidSnapshot({
      snapshot: snapshotOf(),
      cart: saleCart(),
      session: session(),
      razorpayOrder: order(),
      razorpayPayments: [payment()],
      ...over,
    })

  it("honours a sale price when the sale ended during a captured payment", () => {
    expect(judge()).toEqual({ honoured: true })
  })

  it("honours an authorized (not yet captured) payment in full", () => {
    expect(judge({ razorpayPayments: [payment({ status: "authorized" })] })).toEqual({ honoured: true })
  })

  it("does not honour a failed payment, so today's price applies on the next try", () => {
    expect(judge({ razorpayOrder: order({ status: "attempted" }), razorpayPayments: [payment({ status: "failed" })] })).toEqual({
      honoured: false,
      reason: "not_paid",
    })
  })

  it("does not honour a payment that was never made (cancelled checkout)", () => {
    expect(judge({ razorpayOrder: order({ status: "created" }), razorpayPayments: [] })).toMatchObject({ reason: "not_paid" })
  })

  it("does not honour a short payment", () => {
    expect(judge({ razorpayPayments: [payment({ amount: 99900 })] })).toMatchObject({ reason: "not_paid" })
  })

  it("does not honour a Razorpay order whose amount differs from the snapshot", () => {
    expect(judge({ razorpayOrder: order({ amount: 50000 }), razorpayPayments: [payment({ amount: 50000 })] })).toMatchObject({
      reason: "amount_mismatch",
    })
  })

  it("does not honour another Razorpay order or another currency", () => {
    expect(judge({ razorpayOrder: order({ id: "order_9" }) })).toMatchObject({ reason: "amount_mismatch" })
    expect(judge({ razorpayOrder: order({ currency: "USD" }) })).toMatchObject({ reason: "amount_mismatch" })
    expect(judge({ razorpayOrder: null })).toMatchObject({ reason: "amount_mismatch" })
  })

  it("does not honour a refunded payment", () => {
    expect(judge({ razorpayPayments: [payment({ status: "refunded" })] })).toMatchObject({ reason: "not_paid" })
  })

  it("checks the cart before trusting Razorpay", () => {
    expect(judge({ cart: { ...saleCart(), total: 2000 } })).toMatchObject({ reason: "amount_mismatch" })
    expect(judge({ snapshot: null })).toMatchObject({ reason: "no_snapshot" })
  })
})

describe("snapshotLines", () => {
  it("skips empty slots", () => {
    expect(snapshotLines({ id: "c", items: [null, { id: "x", quantity: 1, unit_price: 5 }] })).toEqual([
      { id: "x", variant_id: null, quantity: 1, unit_price_paise: 500 },
    ])
  })
})
