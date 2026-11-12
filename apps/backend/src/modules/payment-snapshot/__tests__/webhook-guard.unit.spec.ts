import crypto from "node:crypto"
import { razorpayWebhookSecret, webhookSignatureValid, webhookTarget, withSessionId } from "../webhook-guard"

const sign = (body: string, secret: string) => crypto.createHmac("sha256", secret).update(body).digest("hex")

const event = (name: string, entity: Record<string, unknown> | null = { id: "pay_1", order_id: "order_1", notes: { medusa_cart_id: "cart_x" } }) => ({
  event: name,
  payload: entity ? { payment: { entity } } : {},
})

describe("webhookSignatureValid", () => {
  const body = JSON.stringify(event("payment.captured"))

  it("accepts Razorpay's HMAC of the exact bytes", () => {
    expect(webhookSignatureValid(Buffer.from(body), sign(body, "s3cret"), "s3cret")).toBe(true)
  })

  it("rejects a wrong secret, a changed body, a missing or malformed signature", () => {
    expect(webhookSignatureValid(Buffer.from(body), sign(body, "other"), "s3cret")).toBe(false)
    expect(webhookSignatureValid(Buffer.from(body + " "), sign(body, "s3cret"), "s3cret")).toBe(false)
    expect(webhookSignatureValid(Buffer.from(body), undefined, "s3cret")).toBe(false)
    expect(webhookSignatureValid(Buffer.from(body), "zz-not-hex", "s3cret")).toBe(false)
    expect(webhookSignatureValid(undefined, sign(body, "s3cret"), "s3cret")).toBe(false)
  })

  it("never passes without a secret", () => {
    expect(webhookSignatureValid(Buffer.from(body), sign(body, ""), "")).toBe(false)
  })
})

describe("webhookTarget", () => {
  it("reads the Razorpay order and payment of a captured or authorized payment", () => {
    expect(webhookTarget(event("payment.captured"))).toEqual({
      event: "payment.captured",
      razorpay_order_id: "order_1",
      razorpay_payment_id: "pay_1",
    })
    expect(webhookTarget(event("payment.authorized"))?.razorpay_order_id).toBe("order_1")
  })

  it("has nothing to act on for other events or a payment with no order", () => {
    expect(webhookTarget(event("payment.failed"))).toBeNull()
    expect(webhookTarget(event("order.paid"))).toBeNull()
    expect(webhookTarget(event("refund.processed"))).toBeNull()
    expect(webhookTarget(event("payment.captured", { id: "pay_1", order_id: null }))).toBeNull()
    expect(webhookTarget(event("payment.captured", null))).toBeNull()
    expect(webhookTarget(null)).toBeNull()
  })
})

describe("withSessionId", () => {
  it("replaces a session id the browser put in the notes", () => {
    const body = event("payment.captured", { id: "pay_1", order_id: "order_1", notes: { session_id: "payses_victim", medusa_cart_id: "c" } })
    withSessionId(body, "payses_real")
    expect((body.payload as any).payment.entity.notes).toEqual({ session_id: "payses_real", medusa_cart_id: "c" })
  })

  it("creates the notes when Razorpay sent none or an empty list", () => {
    const none = event("payment.captured", { id: "pay_1", order_id: "order_1" })
    withSessionId(none, "payses_real")
    expect((none.payload as any).payment.entity.notes).toEqual({ session_id: "payses_real" })
    const list = event("payment.captured", { id: "pay_1", order_id: "order_1", notes: [] })
    withSessionId(list, "payses_real")
    expect((list.payload as any).payment.entity.notes).toEqual({ session_id: "payses_real" })
  })
})

describe("razorpayWebhookSecret", () => {
  it("prefers the test secret and ignores a blank one", () => {
    expect(razorpayWebhookSecret({ RAZORPAY_TEST_WEBHOOK_SECRET: "t", RAZORPAY_WEBHOOK_SECRET: "l" } as any)).toBe("t")
    expect(razorpayWebhookSecret({ RAZORPAY_TEST_WEBHOOK_SECRET: "", RAZORPAY_WEBHOOK_SECRET: "l" } as any)).toBe("l")
    expect(razorpayWebhookSecret({} as any)).toBe("")
  })
})
