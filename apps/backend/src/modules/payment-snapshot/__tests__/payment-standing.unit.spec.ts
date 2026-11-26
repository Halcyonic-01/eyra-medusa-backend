import { judgeStanding, pendingRule, PENDING_HOLD_MINUTES } from "../payment-standing"
import type { PaidAttempts } from "../late-payments"

const now = new Date("2026-11-26T10:00:00Z")
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000)
const nothing: PaidAttempts = { current: false, replaced: false, pending_providers: [], pending: [], paid_provider: null }
const pending = (provider_id: string, m: number) => ({ provider_id, ref: `ref_${provider_id}_${m}`, current: true, since: minutesAgo(m) })

describe("pendingRule", () => {
  it("allows nothing while a payment is within the hold", () => {
    expect(pendingRule([pending("pp_payu_payu", 5)], now)).toMatchObject({ can_pay: false, allowed: [] })
  })
  it("after the hold allows the same provider only", () => {
    expect(pendingRule([pending("pp_payu_payu", PENDING_HOLD_MINUTES + 1)], now)).toMatchObject({ can_pay: true, allowed: ["pp_payu_payu"] })
  })
  it("payments pending with two providers allow nothing, however old", () => {
    expect(pendingRule([pending("pp_payu_payu", 90), pending("pp_razorpay_razorpay", 90)], now).can_pay).toBe(false)
  })
  it("the newest pending payment sets the hold", () => {
    const rule = pendingRule([pending("pp_payu_payu", 90), pending("pp_payu_payu", 2)], now)
    expect(rule.can_pay).toBe(false)
    expect(rule.retry_after.getTime()).toBe(minutesAgo(2).getTime() + PENDING_HOLD_MINUTES * 60 * 1000)
  })
})

describe("judgeStanding", () => {
  const base = { cart_id: "cart_1", order_id: null, refunds: [] }
  it("an order wins over everything", () => {
    expect(judgeStanding({ ...base, order_id: "order_1", paid: null }, now)).toMatchObject({ state: "ordered", can_pay: false })
  })
  it("an unanswered provider never allows paying", () => {
    expect(judgeStanding({ ...base, paid: null }, now)).toMatchObject({ state: "unknown", can_pay: false, allowed_providers: [] })
  })
  it("money taken never allows paying, even with something else pending", () => {
    const paid = { ...nothing, current: true, paid_provider: "pp_razorpay_razorpay", pending: [pending("pp_payu_payu", 90)] }
    expect(judgeStanding({ ...base, paid }, now)).toMatchObject({ state: "paid", can_pay: false })
  })
  it("nothing paid or pending allows any provider", () => {
    expect(judgeStanding({ ...base, paid: nothing }, now)).toMatchObject({ state: "none", can_pay: true, allowed_providers: "any" })
  })
})
