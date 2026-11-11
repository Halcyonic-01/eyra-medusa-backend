import { judgePaymentStanding, type StandingOrder } from "../payment-standing"

const order = (over: Partial<StandingOrder> = {}): StandingOrder => ({
  id: "order_1",
  total: 2000,
  metadata: null,
  has_cart: true,
  replacement_linked: false,
  override: false,
  payment_collections: [{ status: "authorized", amount: 2000, payments: [{ amount: 2000, canceled_at: null, provider_id: "pp_razorpay_razorpay" }] }],
  ...over,
})

describe("judgePaymentStanding", () => {
  it("ships a checkout order with its Razorpay payment recorded", () => {
    expect(judgePaymentStanding(order())).toEqual({ ok: true, kind: "paid" })
  })

  it("ships a Cash on Delivery order with its system payment recorded", () => {
    const cod = order({ total: 2099, payment_collections: [{ status: "authorized", amount: 2099, payments: [{ amount: 2099, canceled_at: null, provider_id: "pp_system_default" }] }] })
    expect(judgePaymentStanding(cod)).toEqual({ ok: true, kind: "paid" })
  })

  it("ships a wallet-only order (nothing due)", () => {
    expect(judgePaymentStanding(order({ total: 0, payment_collections: [] }))).toEqual({ ok: true, kind: "no_payment_due" })
    expect(judgePaymentStanding(order({ total: 0, payment_collections: [{ status: "not_paid", amount: 0, payments: [] }] }))).toMatchObject({ ok: true })
  })

  it("counts a part-wallet order as paid when the rest is", () => {
    const part = order({ total: 1500, payment_collections: [{ status: "authorized", amount: 1500, payments: [{ amount: 1500, canceled_at: null, provider_id: "pp_razorpay_razorpay" }] }] })
    expect(judgePaymentStanding(part).ok).toBe(true)
  })

  it("holds an order whose payment record is missing (crash before authorization)", () => {
    expect(judgePaymentStanding(order({ payment_collections: [{ status: "not_paid", amount: 2000, payments: [] }] }))).toEqual({
      ok: false,
      reason: "no_payment_record",
    })
    expect(judgePaymentStanding(order({ payment_collections: [] }))).toMatchObject({ reason: "no_payment_record" })
  })

  it("holds an order whose only payment was canceled, or is short", () => {
    const canceled = order({ payment_collections: [{ status: "authorized", amount: 2000, payments: [{ amount: 2000, canceled_at: new Date(), provider_id: "pp_razorpay_razorpay" }] }] })
    expect(judgePaymentStanding(canceled)).toMatchObject({ ok: false, reason: "no_payment_record" })
    const short = order({ payment_collections: [{ status: "partially_authorized", amount: 2000, payments: [{ amount: 1000, canceled_at: null, provider_id: "pp_razorpay_razorpay" }] }] })
    expect(judgePaymentStanding(short)).toMatchObject({ ok: false, reason: "payment_short" })
  })

  it("ignores a canceled payment collection", () => {
    const withOld = order({
      payment_collections: [
        { status: "canceled", amount: 5000, payments: [] },
        { status: "authorized", amount: 2000, payments: [{ amount: 2000, canceled_at: null, provider_id: "pp_razorpay_razorpay" }] },
      ],
    })
    expect(judgePaymentStanding(withOld).ok).toBe(true)
  })

  it("holds an order not linked to a checkout (crash before linking), even if paid", () => {
    expect(judgePaymentStanding(order({ has_cart: false }))).toEqual({ ok: false, reason: "no_cart" })
  })

  it("ships a replacement only when its exchange request names it", () => {
    const replacement = order({ has_cart: false, payment_collections: [], metadata: { replacement_for_order: "order_0" } })
    expect(judgePaymentStanding({ ...replacement, replacement_linked: true })).toEqual({ ok: true, kind: "replacement" })
    expect(judgePaymentStanding(replacement)).toEqual({ ok: false, reason: "replacement_unlinked" })
  })

  it("lets a staff override stand in for the checkout link of an admin-made order, but not for payment", () => {
    expect(judgePaymentStanding(order({ has_cart: false, override: true }))).toEqual({ ok: true, kind: "override" })
    const unpaid = order({ has_cart: false, override: true, payment_collections: [{ status: "not_paid", amount: 2000, payments: [] }] })
    expect(judgePaymentStanding(unpaid)).toMatchObject({ ok: false, reason: "no_payment_record" })
  })

  it("never lets an override ship a leftover from an interrupted checkout", () => {
    const leftover = order({ has_cart: false, override: true, metadata: { eyra_checkout_cart_id: "cart_1" } })
    expect(judgePaymentStanding(leftover)).toEqual({ ok: false, reason: "no_cart" })
  })

  it("never treats an unreadable total as nothing due", () => {
    expect(judgePaymentStanding(order({ total: Number.NaN, payment_collections: [] }))).toMatchObject({ ok: false, reason: "no_payment_record" })
  })
})
