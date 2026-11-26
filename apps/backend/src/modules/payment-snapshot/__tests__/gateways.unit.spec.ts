import { getRefundGateway, type RefundGateway } from "../../order-dispatch/refund-gateway"
import { paymentModeFor } from "../../../utils/commerce-rules"
import {
  COD_PROVIDER_ID,
  GatewayUnavailableError,
  RAZORPAY_PROVIDER_ID,
  checkoutLockKey,
  getGateway,
  isPrepaidProvider,
  paidTowardsAttempt,
  prepaidProviderIds,
  registerGateway,
  sessionAttempt,
  type PrepaidGateway,
} from "../gateways"
import { RazorpayUnavailableError } from "../razorpay-api"

const OTHER = "pp_otherpay_otherpay"

const otherRefunds: RefundGateway = {
  paymentRefundState: async () => ({ status: "known", amount: 1, refunded: 0 }),
  refund: async (request) => ({ ok: true, refund_id: `other_${request.payment_ref}`, verified: true }),
  refundStatus: async () => "processed",
}

const otherGateway: PrepaidGateway = {
  provider_id: OTHER,
  name: "OtherPay",
  sessionRef: (session) => ((session?.data as { txn?: string } | null)?.txn ?? null),
  sessionAttemptAmount: (session) => Number((session?.data as { paise?: number } | null)?.paise),
  fetchAttempt: async () => null,
  rebindSession: async () => undefined,
  refunds: () => otherRefunds,
}

describe("provider registry", () => {
  const env = process.env.REFUND_GATEWAY
  afterEach(() => {
    process.env.REFUND_GATEWAY = env
  })

  it("knows Razorpay and PayU as the online providers until another is registered", () => {
    expect(prepaidProviderIds()).toEqual([RAZORPAY_PROVIDER_ID, "pp_payu_payu"])
    expect(isPrepaidProvider(RAZORPAY_PROVIDER_ID)).toBe(true)
    expect(isPrepaidProvider(COD_PROVIDER_ID)).toBe(false)
    expect(isPrepaidProvider(OTHER)).toBe(false)
    expect(isPrepaidProvider(null)).toBe(false)
    expect(getGateway(OTHER)).toBeNull()
    expect(getGateway(COD_PROVIDER_ID)).toBeNull()
    expect(getGateway(RAZORPAY_PROVIDER_ID)?.name).toBe("Razorpay")
  })

  it("reads a session's attempt through its own provider's gateway", () => {
    const razorpay = { provider_id: RAZORPAY_PROVIDER_ID, data: { razorpayOrder: { id: "order_1", amount: 5000 } } }
    expect(sessionAttempt(razorpay).ref).toBe("order_1")
    expect(getGateway(RAZORPAY_PROVIDER_ID)!.sessionAttemptAmount(razorpay)).toBe(5000)
    expect(sessionAttempt({ provider_id: COD_PROVIDER_ID, data: {} })).toEqual({ gateway: null, ref: null })
    expect(sessionAttempt(null)).toEqual({ gateway: null, ref: null })
  })

  it("does not refund an unregistered provider's payment, and says so", async () => {
    delete process.env.REFUND_GATEWAY
    const result = await getRefundGateway("pp_unknown_unknown").refund({
      order_id: "order_1", payment_ref: "x", attempt_ref: null, amount: 10, fee: 0, cancellation_id: "c", since_ms: 0,
    })
    expect(result).toEqual({ ok: false, error: expect.stringContaining("pp_unknown_unknown"), may_have_moved_money: false })
    expect(await getRefundGateway("pp_unknown_unknown").paymentRefundState("x", null)).toEqual({ status: "unknown" })
  })

  it("registering a provider makes it prepaid and routes its refunds to it", async () => {
    delete process.env.REFUND_GATEWAY
    expect(paymentModeFor([OTHER], 100)).toBeNull()
    registerGateway(otherGateway)
    expect(isPrepaidProvider(OTHER)).toBe(true)
    expect(getGateway(OTHER)).toBe(otherGateway)
    expect(sessionAttempt({ provider_id: OTHER, data: { txn: "txn_9" } })).toEqual({ gateway: otherGateway, ref: "txn_9" })
    expect(paymentModeFor([OTHER], 100)).toBe("prepaid")
    const refund = await getRefundGateway(OTHER).refund({
      order_id: "order_1", payment_ref: "pay_9", attempt_ref: "txn_9", amount: 10, fee: 0, cancellation_id: "c", since_ms: 0,
    })
    expect(refund).toEqual({ ok: true, refund_id: "other_pay_9", verified: true })
    // Razorpay is untouched.
    expect(paymentModeFor([RAZORPAY_PROVIDER_ID], 100)).toBe("prepaid")
    expect(paymentModeFor([COD_PROVIDER_ID], 100)).toBe("cod")
    expect(paymentModeFor([COD_PROVIDER_ID], 0)).toBe("prepaid")
  })

  it("the fake refund mode still replaces every provider in tests", async () => {
    process.env.REFUND_GATEWAY = "fake"
    const result = await getRefundGateway(OTHER).refund({
      order_id: "order_1", payment_ref: "pay_9", attempt_ref: null, amount: 10, fee: 0, cancellation_id: "c1", since_ms: 0,
    })
    expect(result).toMatchObject({ ok: true, refund_id: "rfnd_FAKE_c1" })
  })

  it("one checkout lock per cart for every provider, with the key the previous release uses", () => {
    // Changing this text lets old and new instances work on the same cart at once during a deploy.
    expect(checkoutLockKey("cart_1")).toBe("razorpay-checkout:cart_1")
  })

  it("Razorpay outages are gateway outages, so shared code catches them without knowing the provider", () => {
    expect(new RazorpayUnavailableError("down")).toBeInstanceOf(GatewayUnavailableError)
  })

  it("counts money taken only for the attempt's own payments", () => {
    expect(
      paidTowardsAttempt({
        ref: "a",
        amount_paise: 300,
        currency: "INR",
        raw: null,
        payments: [
          { id: "1", attempt_ref: "a", amount_paise: 100, currency: "INR", status: "captured" },
          { id: "2", attempt_ref: "a", amount_paise: 100, currency: "inr", status: "authorized" },
          { id: "3", attempt_ref: "a", amount_paise: 100, currency: "INR", status: "pending" },
          { id: "4", attempt_ref: "b", amount_paise: 100, currency: "INR", status: "captured" },
          { id: "5", attempt_ref: "a", amount_paise: 100, currency: "USD", status: "captured" },
        ],
      })
    ).toBe(200)
  })
})
