import type { GatewayAttempt, GatewayPayment } from "../gateways/types"
import { attemptMatchesCart, judgeLateAttempt, type AttemptFacts } from "../late-payment-rules"
import { RAZORPAY_PROVIDER_ID } from "../rules"

const OTHER = "pp_otherpay_otherpay"
const lines = [{ id: "cali_1", variant_id: "variant_1", quantity: 1, unit_price_paise: 200000 }]

const payment = (overrides: Partial<GatewayPayment> = {}): GatewayPayment => ({
  id: "pay_late",
  attempt_ref: "order_old",
  amount_paise: 200000,
  currency: "INR",
  status: "captured",
  ...overrides,
})

const attempt = (payments: GatewayPayment[] = [payment()], overrides: Partial<GatewayAttempt> = {}): GatewayAttempt => ({
  ref: "order_old",
  amount_paise: 200000,
  currency: "INR",
  payments,
  raw: null,
  ...overrides,
})

function facts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    snapshot: {
      cart_id: "cart_1",
      provider_id: RAZORPAY_PROVIDER_ID,
      provider_ref: "order_old",
      provider_amount_paise: 200000,
      amount_paise: 200000,
      currency_code: "inr",
      lines,
    },
    attempt: attempt(),
    cart: { id: "cart_1", currency_code: "inr", total: 2000, items: [{ id: "cali_1", variant_id: "variant_1", quantity: 1, unit_price: 2000 }] },
    currentSession: {
      id: "payses_new",
      provider_id: RAZORPAY_PROVIDER_ID,
      status: "pending",
      amount: 2000,
      currency_code: "inr",
      data: { razorpayOrder: { id: "order_new" } },
    },
    currentSessionRef: "order_new",
    currentPaidPaise: 0,
    order: null,
    ...overrides,
  }
}

describe("judgeLateAttempt", () => {
  it("recovers a paid replaced attempt that still matches the open cart", () => {
    expect(judgeLateAttempt(facts())).toEqual({ action: "recover" })
  })

  it("reads rows written before the provider columns (Razorpay columns only)", () => {
    const legacy = { ...facts().snapshot, provider_ref: null, provider_amount_paise: null, razorpay_order_id: "order_old", razorpay_amount_paise: 200000 }
    expect(judgeLateAttempt(facts({ snapshot: legacy }))).toEqual({ action: "recover" })
  })

  it("does nothing when the attempt was never paid, or only authorized", () => {
    expect(judgeLateAttempt(facts({ attempt: attempt([]) }))).toMatchObject({ action: "none", reason: "not_paid" })
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ status: "failed" })]) }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ status: "refunded" })]) }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ status: "pending" })]) }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ status: "authorized" })]) }))).toMatchObject({ reason: "authorized_only" })
    expect(judgeLateAttempt(facts({ attempt: null }))).toMatchObject({ reason: "not_paid" })
  })

  it("ignores a provider answer for another attempt", () => {
    expect(judgeLateAttempt(facts({ attempt: attempt([payment()], { ref: "order_other" }) }))).toMatchObject({ reason: "not_paid" })
  })

  it("leaves an attempt alone once it is the order's own payment", () => {
    const order = { id: "order_1", attempt_refs: ["order_old"] }
    expect(judgeLateAttempt(facts({ order }))).toMatchObject({ action: "none", reason: "in_order" })
  })

  it("refunds when the cart became an order paid some other way", () => {
    const order = { id: "order_1", attempt_refs: ["order_new"] }
    expect(judgeLateAttempt(facts({ order }))).toMatchObject({ action: "refund", reason: "ordered_otherwise", payments: [payment()] })
    const cod = { id: "order_2", attempt_refs: [] }
    expect(judgeLateAttempt(facts({ order: cod }))).toMatchObject({ action: "refund", reason: "ordered_otherwise" })
  })

  it("waits while an order is being written", () => {
    expect(judgeLateAttempt(facts({ cart: { ...facts().cart, completed_at: new Date() } }))).toMatchObject({ action: "none", reason: "order_pending" })
  })

  it("is not late when the current session already pays this attempt", () => {
    expect(judgeLateAttempt(facts({ currentSessionRef: "order_old" }))).toMatchObject({ action: "none", reason: "current_attempt" })
  })

  it("waits for the current attempt when it was paid too", () => {
    expect(judgeLateAttempt(facts({ currentPaidPaise: 200000 }))).toMatchObject({ action: "wait" })
    const authorized = { ...facts().currentSession!, status: "authorized" }
    expect(judgeLateAttempt(facts({ currentSession: authorized }))).toMatchObject({ action: "wait" })
  })

  it("refunds when the cart is now paid another way or has no payment", () => {
    const cod = { ...facts().currentSession!, provider_id: "pp_system_default", data: {} }
    expect(judgeLateAttempt(facts({ currentSession: cod, currentSessionRef: null }))).toMatchObject({ action: "refund", reason: "checkout_changed" })
    expect(judgeLateAttempt(facts({ currentSession: null, currentSessionRef: null }))).toMatchObject({ action: "refund", reason: "checkout_changed" })
  })

  it("never puts a payment of one provider on a session of another", () => {
    const other = { ...facts().currentSession!, provider_id: OTHER, data: { txn: "txn_1" } }
    expect(judgeLateAttempt(facts({ currentSession: other, currentSessionRef: "txn_1" }))).toMatchObject({ action: "refund", reason: "checkout_changed" })
    // Even when the other provider happens to use the same reference.
    expect(judgeLateAttempt(facts({ currentSession: other, currentSessionRef: "order_old" }))).toMatchObject({ action: "refund", reason: "checkout_changed" })
  })

  it("treats another provider's attempt like any other: recovered onto a session of its own provider", () => {
    const snapshot = { ...facts().snapshot, provider_id: OTHER, provider_ref: "txn_old" }
    const current = { ...facts().currentSession!, provider_id: OTHER, data: { txn: "txn_new" } }
    const paid = attempt([payment({ attempt_ref: "txn_old" })], { ref: "txn_old" })
    expect(judgeLateAttempt(facts({ snapshot, attempt: paid, currentSession: current, currentSessionRef: "txn_new" }))).toEqual({ action: "recover" })
    // A Razorpay session now: that payment cannot go on it.
    expect(judgeLateAttempt(facts({ snapshot, attempt: paid }))).toMatchObject({ action: "refund", reason: "checkout_changed" })
    // Ordered with Razorpay: refunded through its own provider (the row keeps the provider).
    const order = { id: "order_1", attempt_refs: ["order_new"] }
    expect(judgeLateAttempt(facts({ snapshot, attempt: paid, order }))).toMatchObject({ action: "refund", reason: "ordered_otherwise" })
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
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ amount_paise: 100000 })]) }))).toMatchObject({ action: "refund", reason: "partial_payment" })
  })

  it("ignores payments for other attempts or in another currency", () => {
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ attempt_ref: "order_other" })]) }))).toMatchObject({ reason: "not_paid" })
    expect(judgeLateAttempt(facts({ attempt: attempt([payment({ currency: "USD" })]) }))).toMatchObject({ reason: "not_paid" })
  })

  it("refunds every captured payment of the attempt, not just one", () => {
    const two = [payment({ id: "pay_a", amount_paise: 100000 }), payment({ id: "pay_b", amount_paise: 100000 })]
    const order = { id: "order_1", attempt_refs: ["order_new"] }
    const decision = judgeLateAttempt(facts({ attempt: attempt(two), order }))
    expect(decision).toMatchObject({ action: "refund" })
    expect((decision as { payments: GatewayPayment[] }).payments.map((p) => p.id)).toEqual(["pay_a", "pay_b"])
  })
})

describe("attemptMatchesCart", () => {
  it("needs the same lines, total, session amount and currency", () => {
    expect(attemptMatchesCart(facts())).toBe(true)
    expect(attemptMatchesCart(facts({ currentSession: null }))).toBe(false)
    expect(attemptMatchesCart(facts({ cart: { ...facts().cart, currency_code: "usd" } }))).toBe(false)
  })
})
