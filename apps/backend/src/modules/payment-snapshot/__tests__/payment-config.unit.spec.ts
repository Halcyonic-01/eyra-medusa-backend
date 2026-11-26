import { getRefundGateway } from "../../order-dispatch/refund-gateway"
import { payuConfig } from "../../payu-payment/config"
import { fakeRefundsAllowed, paymentConfigProblems, payuHostAllowed, payuLiveProblems } from "../payment-config"
import { payuEventKey } from "../webhook-events"

const live = {
  PAYU_MERCHANT_KEY: "k",
  PAYU_MERCHANT_SALT: "s",
  PAYU_MODE: "live",
  PAYU_SUCCESS_URL: "https://www.eyra.org.in/api/payu/return",
  PAYU_FAILURE_URL: "https://www.eyra.org.in/api/payu/return",
}

describe("payment configuration checks", () => {
  it("flags test Razorpay credentials, test keys and fake refunds in production", () => {
    const problems = paymentConfigProblems({
      NODE_ENV: "production",
      RAZORPAY_ID: "rzp_test_abc",
      RAZORPAY_WEBHOOK_SECRET: "w",
      RAZORPAY_TEST_KEY_ID: "rzp_test_x",
      REFUND_GATEWAY: "fake",
    })
    expect(problems.join("\n")).toMatch(/RAZORPAY_TEST_KEY_ID set in production/)
    expect(problems.join("\n")).toMatch(/test key \(rzp_test_\)/)
    expect(problems.join("\n")).toMatch(/REFUND_GATEWAY is set to a test stand-in/)
  })

  it("flags a missing webhook secret anywhere, and nothing for a clean live setup", () => {
    expect(paymentConfigProblems({ NODE_ENV: "development" }).join("\n")).toMatch(/RAZORPAY_WEBHOOK_SECRET is not set/)
    expect(paymentConfigProblems({ NODE_ENV: "production", RAZORPAY_ID: "rzp_live_x", RAZORPAY_WEBHOOK_SECRET: "w", ...live })).toEqual([])
  })

  it("PayU live mode refuses overrides outside PayU and plain-http return addresses", () => {
    expect(payuLiveProblems({ ...live, PAYU_API_URL: "http://127.0.0.1:19443/merchant/postservice.php" })).toHaveLength(1)
    expect(payuLiveProblems({ ...live, PAYU_SUCCESS_URL: "http://www.eyra.org.in/api/payu/return" })).toHaveLength(1)
    expect(payuLiveProblems({ ...live, PAYU_CHECKOUT_URL: "https://secure.payu.in/_payment" })).toEqual([])
    expect(payuHostAllowed("https://secure.payu.in.evil.com/_payment")).toBe(false)
    expect(payuLiveProblems({ ...live, PAYU_MODE: "test", PAYU_API_URL: "http://127.0.0.1:1" })).toEqual([])
  })

  it("PayU is switched off, never half-on, when live settings are unsafe", () => {
    expect(payuConfig({ ...live } as NodeJS.ProcessEnv)).toMatchObject({ mode: "live", apiUrl: "https://info.payu.in/merchant/postservice.php?form=2" })
    expect(payuConfig({ ...live, PAYU_CHECKOUT_URL: "https://pay.example.com/_payment" } as NodeJS.ProcessEnv)).toBeNull()
    expect(payuConfig({ ...live, PAYU_FAILURE_URL: "http://x.in/r" } as NodeJS.ProcessEnv)).toBeNull()
    expect(payuConfig({ ...live, PAYU_MODE: "test", PAYU_API_URL: "http://127.0.0.1:1/x" } as NodeJS.ProcessEnv)).toMatchObject({ mode: "test" })
  })

  it("PayU return addresses longer than PayU accepts are flagged", () => {
    expect(paymentConfigProblems({ ...live, PAYU_MODE: "test", RAZORPAY_WEBHOOK_SECRET: "w", PAYU_SUCCESS_URL: `https://${"a".repeat(60)}.in` }).join("\n")).toMatch(
      /PAYU_SUCCESS_URL is longer than the 50 characters/
    )
  })
})

describe("refunds in production", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("never uses the fake stand-ins in production, even when REFUND_GATEWAY says so", async () => {
    expect(fakeRefundsAllowed({ NODE_ENV: "production" })).toBe(false)
    expect(fakeRefundsAllowed({ NODE_ENV: "test" })).toBe(true)
    process.env = { ...saved, NODE_ENV: "production", REFUND_GATEWAY: "fake", RAZORPAY_ID: "", RAZORPAY_SECRET: "", RAZORPAY_TEST_KEY_ID: "", RAZORPAY_TEST_KEY_SECRET: "" }
    delete process.env.RAZORPAY_ID
    delete process.env.RAZORPAY_SECRET
    delete process.env.RAZORPAY_TEST_KEY_ID
    delete process.env.RAZORPAY_TEST_KEY_SECRET
    const result = await getRefundGateway().refund({
      order_id: "order_1", payment_ref: "pay_1", attempt_ref: null, amount: 10, fee: 0, cancellation_id: "c1", since_ms: Date.now(),
    })
    // The real Razorpay gateway (no keys here), not a fake "refunded".
    expect(result).toMatchObject({ ok: false, error: "Razorpay keys are not set on the backend" })
  })

  it("in tests the fake stand-in still answers", async () => {
    process.env = { ...saved, NODE_ENV: "test", REFUND_GATEWAY: "fake" }
    const result = await getRefundGateway().refund({
      order_id: "order_1", payment_ref: "pay_1", attempt_ref: null, amount: 10, fee: 0, cancellation_id: "c1", since_ms: Date.now(),
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe("PayU webhook keys", () => {
  it("use only fields PayU's hash covers, so an edited mihpayid is the same notice", () => {
    expect(payuEventKey({ status: "success", txnid: "eyra1" })).toBe("success:eyra1")
    expect(payuEventKey({ status: "Success", txnid: "eyra1", mihpayid: "999" } as never)).toBe("success:eyra1")
    expect(payuEventKey({ status: "pending", txnid: "eyra1" })).not.toBe(payuEventKey({ status: "success", txnid: "eyra1" }))
  })
})
