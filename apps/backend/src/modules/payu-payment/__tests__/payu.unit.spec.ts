import crypto from "node:crypto"
import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import { createFakePayu, FAKE_PAYU_KEY, FAKE_PAYU_SALT } from "../../../../integration-tests/http/helpers/fake-payu"
import { getGateway, PAYU_PROVIDER_ID, RAZORPAY_PROVIDER_ID, isPrepaidProvider } from "../../payment-snapshot/gateways"
import { payuAttempt } from "../attempt"
import { buildCheckoutForm } from "../checkout-form"
import { payuConfig } from "../config"
import {
  clip,
  commandHash,
  formatAmount,
  newTxnId,
  refundToken,
  requestHash,
  responseHash,
  responseHashValid,
  toPaise,
  transactionState,
} from "../hash"
import { payuRefunds } from "../refunds"
import PayuProviderService from "../service"

const sha512 = (text: string) => crypto.createHash("sha512").update(text).digest("hex")
const API = "https://payu.fake/merchant/postservice.php?form=2"

const request = { key: "K", txnid: "eyratxn1", amount: "2000.00", productinfo: "EYRA order", firstname: "Asha", email: "a@example.com", udf1: "cart_1" }

describe("PayU hashes (docs.payu.in formulas)", () => {
  it("signs the payment request as key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT", () => {
    // 16 pipes in all, as in PayU's sample code: udf2..udf5 after udf1, then six before the salt.
    expect(requestHash(request, "S")).toBe(sha512("K|eyratxn1|2000.00|EYRA order|Asha|a@example.com|cart_1||||||||||S"))
    expect(requestHash(request, "S")).toMatch(/^[0-9a-f]{128}$/)
  })

  it("checks the reverse hash SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key", () => {
    const response = { ...request, status: "success" }
    const expected = sha512("S|success||||||||||cart_1|a@example.com|Asha|EYRA order|2000.00|eyratxn1|K")
    expect(responseHash(response, "S")).toBe(expected)
    expect(responseHashValid({ ...response, hash: expected }, "K", "S")).toBe(true)
    expect(responseHashValid({ ...response, hash: expected.toUpperCase() }, "K", "S")).toBe(true)
  })

  it("puts additional charges in front when PayU added them", () => {
    const response = { ...request, status: "success", additional_charges: "40.00" }
    expect(responseHash(response, "S")).toBe(sha512("40.00|S|success||||||||||cart_1|a@example.com|Asha|EYRA order|2000.00|eyratxn1|K"))
  })

  it("rejects a tampered or foreign response", () => {
    const good = { ...request, status: "success", hash: responseHash({ ...request, status: "success" }, "S") }
    expect(responseHashValid(good, "K", "S")).toBe(true)
    expect(responseHashValid({ ...good, amount: "1.00" }, "K", "S")).toBe(false)
    expect(responseHashValid({ ...good, status: "failure" }, "K", "S")).toBe(false)
    expect(responseHashValid({ ...good, txnid: "other" }, "K", "S")).toBe(false)
    expect(responseHashValid(good, "OTHER_KEY", "S")).toBe(false)
    expect(responseHashValid(good, "K", "WRONG_SALT")).toBe(false)
    expect(responseHashValid({ ...good, hash: "abc" }, "K", "S")).toBe(false)
    expect(responseHashValid({ ...good, hash: undefined }, "K", "S")).toBe(false)
    // A failure response cannot be turned into a success by editing the status.
    const failed = { ...request, status: "failure", hash: responseHash({ ...request, status: "failure" }, "S") }
    expect(responseHashValid({ ...failed, status: "success" }, "K", "S")).toBe(false)
  })

  it("signs merchant API commands as key|command|var1|SALT", () => {
    expect(commandHash("K", "verify_payment", "eyratxn1", "S")).toBe(sha512("K|verify_payment|eyratxn1|S"))
  })
})

describe("PayU fields", () => {
  it("formats amounts with two decimals and reads them back in paise", () => {
    expect(formatAmount(200000)).toBe("2000.00")
    expect(formatAmount(1999)).toBe("19.99")
    expect(() => formatAmount(0)).toThrow()
    expect(() => formatAmount(12.5)).toThrow()
    expect(toPaise("2000.00")).toBe(200000)
    expect(toPaise("19.99")).toBe(1999)
    expect(Number.isNaN(toPaise("x"))).toBe(true)
  })

  it("makes transaction ids of letters and digits within PayU's 25 characters, unique per attempt", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTxnId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9]{1,25}$/)
    expect(newTxnId(() => "a-b_c|d".repeat(10))).toMatch(/^[a-zA-Z0-9]{1,25}$/)
  })

  it("derives one refund token per refund, within PayU's 23 characters", () => {
    expect(refundToken("lrp_1")).toBe(refundToken("lrp_1"))
    expect(refundToken("lrp_1")).not.toBe(refundToken("lrp_2"))
    expect(refundToken("x".repeat(500))).toMatch(/^[a-z0-9]{23}$/)
  })

  it("keeps customer text within limits and out of the hash separators", () => {
    expect(clip("Asha | Rao", 20)).toBe("Asha   Rao")
    expect(clip("x".repeat(30), 20)).toHaveLength(20)
    expect(clip(null, 5)).toBe("")
  })

  it("reads verify_payment states, never taking pending or unknown as paid", () => {
    expect(transactionState({ status: "success", unmappedstatus: "captured" })).toBe("captured")
    expect(transactionState({ status: "success", unmappedstatus: "auth" })).toBe("authorized")
    expect(transactionState({ status: "pending", unmappedstatus: "pending" })).toBe("pending")
    expect(transactionState({ status: "failure", unmappedstatus: "userCancelled" })).toBe("failed")
    expect(transactionState({ status: "failure", unmappedstatus: "bounced" })).toBe("failed")
    expect(transactionState({ status: "Not Found", mihpayid: "Not Found" })).toBe("not_found")
    expect(transactionState(null)).toBe("not_found")
  })

  it("maps a transaction onto the shared attempt shape", () => {
    expect(payuAttempt("t1", null)).toBeNull()
    expect(payuAttempt("t1", { status: "Not Found", mihpayid: "Not Found" })).toBeNull()
    expect(payuAttempt("t1", { txnid: "t1", mihpayid: "403", status: "success", unmappedstatus: "captured", amt: "2000.00", transaction_amount: "2000.00" })).toMatchObject({
      ref: "t1",
      amount_paise: 200000,
      currency: "INR",
      payments: [{ id: "403", attempt_ref: "t1", amount_paise: 200000, status: "captured" }],
    })
    expect(payuAttempt("t1", { txnid: "t1", mihpayid: "403", status: "pending", amt: "2000.00" })!.payments[0].status).toBe("pending")
  })
})

describe("PayU hosted checkout form", () => {
  const config = { key: "K", salt: "S", mode: "test" as const, checkoutUrl: "https://test.payu.in/_payment", apiUrl: API, successUrl: "https://eyra.test/p/ok", failureUrl: "https://eyra.test/p/no" }

  it("is signed with the session's own transaction and amount, and never contains the salt", () => {
    const form = buildCheckoutForm(config, { txnid: "eyratxn1", amount_paise: 200000, cart_id: "cart_1", customer: { email: "a@example.com", firstname: "Asha", lastname: "Rao", phone: "9999999999" } })
    expect(form.action).toBe("https://test.payu.in/_payment")
    expect(form.fields).toMatchObject({ key: "K", txnid: "eyratxn1", amount: "2000.00", firstname: "Asha", email: "a@example.com", phone: "9999999999", surl: config.successUrl, furl: config.failureUrl, udf1: "cart_1" })
    expect(form.fields.hash).toBe(requestHash(form.fields as never, "S"))
    expect(Object.values(form.fields)).not.toContain("S")
  })

  it("needs return URLs", () => {
    expect(() => buildCheckoutForm({ ...config, successUrl: "" }, { txnid: "t", amount_paise: 100, cart_id: "c", customer: { email: "e", firstname: "f", phone: "p" } })).toThrow()
  })
})

describe("PayU configuration", () => {
  it("is read from the environment only, test hosts unless live", () => {
    expect(payuConfig({})).toBeNull()
    expect(payuConfig({ PAYU_MERCHANT_KEY: "k" })).toBeNull()
    expect(payuConfig({ PAYU_MERCHANT_KEY: "k", PAYU_MERCHANT_SALT: "s" })).toMatchObject({ mode: "test", checkoutUrl: "https://test.payu.in/_payment", apiUrl: "https://test.payu.in/merchant/postservice.php?form=2" })
    expect(payuConfig({ PAYU_MERCHANT_KEY: "k", PAYU_MERCHANT_SALT: "s", PAYU_MODE: "live" })).toMatchObject({ mode: "live", checkoutUrl: "https://secure.payu.in/_payment", apiUrl: "https://info.payu.in/merchant/postservice.php?form=2" })
  })
})

describe("PayU against a fake merchant API", () => {
  const env = { ...process.env }
  let fake: ReturnType<typeof createFakePayu>
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    fake = createFakePayu()
    Object.assign(process.env, { PAYU_MERCHANT_KEY: FAKE_PAYU_KEY, PAYU_MERCHANT_SALT: FAKE_PAYU_SALT, PAYU_API_URL: API, REFUND_GATEWAY: "" })
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fake.fetchHandler(API) as typeof fetch)
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    process.env = { ...env }
  })

  const service = () => new PayuProviderService({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never)
  const session = (txnid: string, paise = 200000) => ({ payu: { txnid, amount_paise: paise, currency_code: "inr" } })

  it("opens a session without calling PayU, INR only", async () => {
    const opened = await service().initiatePayment({ amount: 2000, currency_code: "inr", context: {} } as never)
    expect(opened.data).toMatchObject({ payu: { amount_paise: 200000, currency_code: "inr" } })
    expect(opened.id).toBe((opened.data as any).payu.txnid)
    expect(fake.calls).toHaveLength(0)
    await expect(service().initiatePayment({ amount: 20, currency_code: "usd" } as never)).rejects.toThrow(/INR/)
  })

  it("authorizes only what PayU confirms, for exactly the session's amount", async () => {
    expect((await service().authorizePayment({ data: session("t_none") } as never)).status).toBe(PaymentSessionStatus.REQUIRES_MORE)
    fake.pay("t_pend", "2000.00", "pending")
    expect((await service().authorizePayment({ data: session("t_pend") } as never)).status).toBe(PaymentSessionStatus.PENDING)
    fake.pay("t_fail", "2000.00", "failure")
    expect((await service().authorizePayment({ data: session("t_fail") } as never)).status).toBe(PaymentSessionStatus.ERROR)
    fake.pay("t_short", "1999.00")
    expect((await service().authorizePayment({ data: session("t_short") } as never)).status).toBe(PaymentSessionStatus.ERROR)
    const paid = fake.pay("t_paid", "2000.00")
    const done = await service().authorizePayment({ data: session("t_paid") } as never)
    expect(done.status).toBe(PaymentSessionStatus.CAPTURED)
    expect(done.data).toMatchObject({ payu: { txnid: "t_paid", mihpayid: paid.mihpayid } })
  })

  it("fails closed when PayU cannot be asked (never 'unpaid')", async () => {
    fake.state.down = true
    await expect(service().authorizePayment({ data: session("t_x") } as never)).rejects.toThrow(/PayU answered 503/)
    await expect(getGateway(PAYU_PROVIDER_ID)!.fetchAttempt("t_x")).rejects.toThrow()
  })

  it("keeps a transaction only for a rebind; a changed amount gets a new one", async () => {
    const same = await service().updatePayment({ data: session("t_1"), amount: 2000, currency_code: "inr" } as never)
    expect((same.data as any).payu.txnid).toBe("t_1")
    const changed = await service().updatePayment({ data: session("t_1"), amount: 2500, currency_code: "inr" } as never)
    expect((changed.data as any).payu.txnid).not.toBe("t_1")
    expect((changed.data as any).payu.amount_paise).toBe(250000)
    const rebound = await service().updatePayment({ data: { payu: { ...session("t_old").payu, rebind: true } }, amount: 2000, currency_code: "inr" } as never)
    expect((rebound.data as any).payu).toEqual({ txnid: "t_old", amount_paise: 200000, currency_code: "inr" })
  })

  it("acts on a webhook only when the guard attached our session and PayU confirms it", async () => {
    fake.pay("t_hook", "2000.00")
    const fields = fake.response({ txnid: "t_hook", amount: "2000.00", status: "success", email: "a@example.com", firstname: "Asha", productinfo: "EYRA order" })
    expect((await service().getWebhookActionAndData({ data: fields } as never)).action).toBe(PaymentActions.NOT_SUPPORTED)
    const ok = await service().getWebhookActionAndData({ data: { ...fields, eyra_session_id: "payses_1" } } as never)
    expect(ok).toEqual({ action: PaymentActions.SUCCESSFUL, data: { session_id: "payses_1", amount: 2000 } })
    const forged = await service().getWebhookActionAndData({ data: { ...fields, amount: "1.00", eyra_session_id: "payses_1" } } as never)
    expect(forged.action).toBe(PaymentActions.NOT_SUPPORTED)
    // A "success" webhook for a transaction PayU still has as pending does nothing.
    fake.pay("t_hook", "2000.00", "pending")
    expect((await service().getWebhookActionAndData({ data: { ...fields, eyra_session_id: "payses_1" } } as never)).action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("refunds once per refund id, however often asked, and finds a refund whose answer was lost", async () => {
    const paid = fake.pay("t_rf", "2000.00")
    const request = { order_id: "order_1", payment_ref: null, attempt_ref: "t_rf", amount: 2000, fee: 0, cancellation_id: "lrp_1", since_ms: 0 }
    const first = await payuRefunds.refund(request)
    expect(first).toMatchObject({ ok: true, verified: true })
    expect(await payuRefunds.refund(request)).toMatchObject({ ok: true, refund_id: (first as any).refund_id })
    expect(fake.refunds).toEqual([expect.objectContaining({ mihpayid: paid.mihpayid, token: refundToken("lrp_1"), amount: "2000.00" })])

    fake.state.refund = "lost"
    expect(await payuRefunds.refund({ ...request, cancellation_id: "lrp_2" })).toMatchObject({ ok: true })
    fake.state.refund = "ok"
    expect(await payuRefunds.refund({ ...request, cancellation_id: "lrp_2" })).toMatchObject({ ok: true })
    expect(fake.refunds.filter((r) => r.token === refundToken("lrp_2"))).toHaveLength(1)
  }, 20000)

  it("reports a clear refusal and an unreachable PayU without sending anything", async () => {
    fake.pay("t_no", "2000.00")
    const request = { order_id: "o", payment_ref: null, attempt_ref: "t_no", amount: 2000, fee: 0, cancellation_id: "lrp_3", since_ms: 0 }
    fake.state.refund = "refuse"
    expect(await payuRefunds.refund(request)).toEqual({ ok: false, error: "Refund request failed", may_have_moved_money: false })
    fake.state.down = true
    expect(await payuRefunds.refund(request)).toMatchObject({ ok: false, may_have_moved_money: false })
    expect(fake.refunds).toHaveLength(0)
    expect(await payuRefunds.paymentRefundState(null, "t_no")).toEqual({ status: "unknown" })
  })

  it("knows how much of a payment was refunded", async () => {
    fake.pay("t_st", "2000.00")
    await payuRefunds.refund({ order_id: "o", payment_ref: null, attempt_ref: "t_st", amount: 500, fee: 0, cancellation_id: "lrp_4", since_ms: 0 })
    expect(await payuRefunds.paymentRefundState(null, "t_st")).toEqual({ status: "known", amount: 2000, refunded: 500 })
  })
})

describe("provider isolation", () => {
  it("PayU and Razorpay are separate online providers, each read only by its own gateway", () => {
    expect(isPrepaidProvider(PAYU_PROVIDER_ID)).toBe(true)
    expect(isPrepaidProvider(RAZORPAY_PROVIDER_ID)).toBe(true)
    const payu = getGateway(PAYU_PROVIDER_ID)!
    const razorpay = getGateway(RAZORPAY_PROVIDER_ID)!
    const payuSession = { data: { payu: { txnid: "t1", amount_paise: 500 } } }
    const razorpaySession = { data: { razorpayOrder: { id: "order_1", amount: 500 } } }
    expect(payu.sessionRef(payuSession)).toBe("t1")
    expect(payu.sessionRef(razorpaySession)).toBeNull()
    expect(razorpay.sessionRef(payuSession)).toBeNull()
    expect(razorpay.sessionRef(razorpaySession)).toBe("order_1")
  })
})
