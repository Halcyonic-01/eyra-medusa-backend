import { attemptMatchesCart, judgeLateAttempt, type AttemptFacts } from "../late-payment-rules"
import { RAZORPAY_PROVIDER_ID, type RazorpayPayment } from "../rules"

const lines = [{ id: "cali_1", variant_id: "variant_1", quantity: 1, unit_price_paise: 200000 }]

const payment = (overrides: Partial<RazorpayPayment> = {}): RazorpayPayment => ({
  id: "pay_late",
  order_id: "order_old",
  amount: 200000,
  currency: "INR",
  status: "captured",
  ...overrides,
})

function facts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    snapshot: { cart_id: "cart_1", razorpay_order_id: "order_old", razorpay_amount_paise: 200000, amount_paise: 200000, currency_code: "inr", lines },
    razorpayOrder: { id: "order_old", amount: 200000, currency: "INR", status: "paid" },
    payments: [payment()],
    cart: { id: "cart_1", currency_code: "inr", total: 2000, items: [{ id: "cali_1", variant_id: "variant_1", quantity: 1, unit_price: 2000 }] },
    currentSession: {
      id: "payses_new",
      provider_id: RAZORPAY_PROVIDER_ID,
      status: "pending",
      amount: 2000,
      currency_code: "inr",
      data: { razorpayOrder: { id: "order_new" } },
    },
    currentPaidPaise: 0,
    order: null,
    ...overrides,
  }
}

describe("judgeLateAttempt", () => {
  it("recovers a paid replaced attempt that still matches the open cart", () => {
    expect(judgeLateAttempt(facts())).toEqual({ action: "recover" })
  })

  it("does nothing when the attempt was never paid, or only authorized", () => {
    expect(judgeLateAttempt(facts({ payments: [] }))).toMatchObject({ action: "none", reason: "not_paid" })
    expect(judgeLateAttempt(facts({ payments: [payment({ status: "failed" })] }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ payments: [payment({ status: "refunded" })] }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ payments: [payment({ status: "authorized" })] }))).toMatchObject({ reason: "authorized_only" })
  })

  it("leaves an attempt alone once it is the order's own payment", () => {
    const order = { id: "order_1", razorpay_order_ids: ["order_old"] }
    expect(judgeLateAttempt(facts({ order }))).toMatchObject({ action: "none", reason: "in_order" })
  })

  it("refunds when the cart became an order paid some other way", () => {
    const order = { id: "order_1", razorpay_order_ids: ["order_new"] }
    expect(judgeLateAttempt(facts({ order }))).toMatchObject({ action: "refund", reason: "ordered_otherwise", payments: [payment()] })
    const cod = { id: "order_2", razorpay_order_ids: [] }
    expect(judgeLateAttempt(facts({ order: cod }))).toMatchObject({ action: "refund", reason: "ordered_otherwise" })
  })

  it("waits while an order is being written", () => {
    expect(judgeLateAttempt(facts({ cart: { ...facts().cart, completed_at: new Date() } }))).toMatchObject({ action: "none", reason: "order_pending" })
  })

  it("is not late when the current session already pays this Razorpay order", () => {
    const currentSession = { ...facts().currentSession!, data: { razorpayOrder: { id: "order_old" } } }
    expect(judgeLateAttempt(facts({ currentSession }))).toMatchObject({ action: "none", reason: "current_attempt" })
  })

  it("waits for the current attempt when it was paid too", () => {
    expect(judgeLateAttempt(facts({ currentPaidPaise: 200000 }))).toMatchObject({ action: "wait" })
    const authorized = { ...facts().currentSession!, status: "authorized" }
    expect(judgeLateAttempt(facts({ currentSession: authorized }))).toMatchObject({ action: "wait" })
  })

  it("refunds when the cart is now paid another way or has no payment", () => {
    const cod = { ...facts().currentSession!, provider_id: "pp_system_default", data: {} }
    expect(judgeLateAttempt(facts({ currentSession: cod }))).toMatchObject({ action: "refund", reason: "not_razorpay_checkout" })
    expect(judgeLateAttempt(facts({ currentSession: null }))).toMatchObject({ action: "refund", reason: "not_razorpay_checkout" })
  })

  it("refunds when the cart changed since the attempt was opened", () => {
    const more = { ...facts().cart, total: 4000, items: [{ id: "cali_1", variant_id: "variant_1", quantity: 2, unit_price: 2000 }] }
    expect(judgeLateAttempt(facts({ cart: more }))).toMatchObject({ action: "refund", reason: "cart_changed" })
    const repriced = { ...facts().cart, items: [{ id: "cali_1", variant_id: "variant_1", quantity: 1, unit_price: 1500 }] }
    expect(judgeLateAttempt(facts({ cart: repriced }))).toMatchObject({ action: "refund", reason: "cart_changed" })
    const session = { ...facts().currentSession!, amount: 1999 }
    expect(judgeLateAttempt(facts({ currentSession: session }))).toMatchObject({ action: "refund", reason: "cart_changed" })
  })

  it("refunds a short payment instead of placing an order for it", () => {
    expect(judgeLateAttempt(facts({ payments: [payment({ amount: 100000 })] }))).toMatchObject({ action: "refund", reason: "partial_payment" })
  })

  it("ignores payments for other Razorpay orders or in another currency", () => {
    expect(judgeLateAttempt(facts({ payments: [payment({ order_id: "order_other" })] }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ payments: [payment({ currency: "USD" })] }))).toMatchObject({ reason: "not_paid" })
  })

  it("refunds every captured payment of the attempt, not just one", () => {
    const two = [payment({ id: "pay_a", amount: 100000 }), payment({ id: "pay_b", amount: 100000 })]
    const order = { id: "order_1", razorpay_order_ids: ["order_new"] }
    const decision = judgeLateAttempt(facts({ payments: two, order }))
    expect(decision).toMatchObject({ action: "refund" })
    expect((decision as { payments: RazorpayPayment[] }).payments.map((p) => p.id)).toEqual(["pay_a", "pay_b"])
  })
})

describe("attemptMatchesCart", () => {
  it("needs the same lines, total, session amount and currency", () => {
    expect(attemptMatchesCart(facts())).toBe(true)
    expect(attemptMatchesCart(facts({ currentSession: null }))).toBe(false)
    expect(attemptMatchesCart(facts({ cart: { ...facts().cart, currency_code: "usd" } }))).toBe(false)
  })
})
