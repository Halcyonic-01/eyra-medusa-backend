import crypto from "node:crypto"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { RefundRequest } from "../../src/modules/order-dispatch/refund-gateway"
import { PAYMENT_SNAPSHOT_MODULE } from "../../src/modules/payment-snapshot"
import {
  GatewayUnavailableError,
  checkoutLockKey,
  registerGateway,
  type GatewayAttempt,
  type PrepaidGateway,
} from "../../src/modules/payment-snapshot/gateways"
import { settleLatePayments } from "../../src/modules/payment-snapshot/late-payments"
import { razorpayWebhookSecret } from "../../src/modules/payment-snapshot/webhook-guard"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

// The provider-neutral payment layer: Razorpay keeps working as before, rows from
// before the provider columns still count, and a second online provider (a fake
// gateway, no Medusa provider needed) is checked, guarded and refunded through
// its own gateway only.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const OTHER = "pp_otherpay_otherpay"

/** A stand-in online provider: tests decide what it says was paid and how its refunds answer. */
function fakeOtherPay() {
  const attempts = new Map<string, GatewayAttempt>()
  const refunds: RefundRequest[] = []
  const state = { down: false, refund: "ok" as "ok" | "refuse", delayMs: 0 }
  const gateway: PrepaidGateway = {
    provider_id: OTHER,
    name: "OtherPay",
    sessionRef: (session) => ((session?.data as { txn?: string } | null)?.txn ?? null),
    sessionAttemptAmount: (session) => Number((session?.data as { paise?: number } | null)?.paise),
    async fetchAttempt(ref) {
      if (state.delayMs) await wait(state.delayMs)
      if (state.down) throw new GatewayUnavailableError("OtherPay is down")
      return attempts.get(ref) ?? null
    },
    rebindSession: async () => {
      throw new Error("not used: no Medusa session of this provider exists in these tests")
    },
    refunds: () => ({
      paymentRefundState: async () => ({ status: "unknown" }),
      refundStatus: async () => "processed" as const,
      async refund(request) {
        if (state.refund === "refuse") return { ok: false, error: "OtherPay refused", may_have_moved_money: false }
        // Idempotent per tag, like a real provider lookup.
        const done = refunds.find((r) => r.cancellation_id === request.cancellation_id)
        if (!done) refunds.push(request)
        return { ok: true, refund_id: `otr_${request.cancellation_id}`, verified: true }
      },
    }),
  }
  const pay = (ref: string, paise: number) => {
    attempts.set(ref, {
      ref,
      amount_paise: paise,
      currency: "INR",
      raw: null,
      payments: [{ id: `otp_${ref}`, attempt_ref: ref, amount_paise: paise, currency: "INR", status: "captured" }],
    })
  }
  return { gateway, refunds, state, pay }
}

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Provider-neutral payment foundation", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      const other = fakeOtherPay()

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19438)
        razorpay.attach(getContainer())
        registerGateway(other.gateway)
      })

      afterAll(() => razorpay.close())

      afterEach(() => {
        razorpay.state.down = false
        razorpay.state.refund = "ok"
        other.state.down = false
        other.state.refund = "ok"
        other.state.delayMs = 0
      })

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
      const snapshots = () => container().resolve(PAYMENT_SNAPSHOT_MODULE) as any
      const variant = () => fx.variantByPrice[2000]
      const address = {
        first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
        city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
      }

      const preparedCart = async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: variant() }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "prepaid")
        return cartId
      }
      const openAttempt = () => (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
      const open = async (cartId: string) => {
        const opened = await flow.must(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
        return { razorpayOrderId: opened.razorpay_order_id as string, sessionId: opened.payment_session_id as string }
      }
      const complete = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
      const ordersFor = async (cartId: string) => {
        const { data } = await query().graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
        return data.map((row: any) => row.order_id as string)
      }
      const orderAttempts = async (cartId: string) => {
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.payments.data"], filters: { id: cartId } })
        return ((data[0] as any)?.payment_collection?.payments ?? []).map((p: any) => p?.data?.razorpayOrder?.id)
      }
      const attemptsOf = async (cartId: string) =>
        (
          await pg().raw(
            `SELECT id, provider_id, provider_ref, provider_amount_paise, razorpay_order_id, payment_session_id, superseded_at
               FROM payment_price_snapshot WHERE cart_id = ? AND deleted_at IS NULL ORDER BY created_at`,
            [cartId]
          )
        ).rows as any[]
      const lateRows = async (cartId: string) =>
        (
          await pg().raw(
            `SELECT provider_id, provider_ref, provider_payment_ref, razorpay_payment_id, status, reason FROM late_razorpay_payment WHERE cart_id = ? AND deleted_at IS NULL`,
            [cartId]
          )
        ).rows as any[]
      const refundsOf = (razorpayOrderId: string) => {
        const ids = new Set((razorpay.payments.get(razorpayOrderId) ?? []).map((p) => p.id))
        return razorpay.refunds.filter((r) => ids.has(r.payment_id))
      }
      /** As rows were before the provider columns existed (written by the previous release). */
      const makeLegacy = (cartId: string) =>
        pg().raw(`UPDATE payment_price_snapshot SET provider_ref = NULL, provider_amount_paise = NULL WHERE cart_id = ?`, [cartId])
      /** An attempt on the other provider, recorded for the cart as its checkout would. */
      const otherAttempt = async (cartId: string, ref: string, paise = 200000) => {
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.id", "items.id", "items.variant_id"], filters: { id: cartId } })
        const cart = data[0] as any
        return snapshots().createPaymentPriceSnapshots({
          cart_id: cartId,
          payment_collection_id: cart.payment_collection?.id ?? "paycol_none",
          payment_session_id: `payses_other_${ref}`,
          provider_id: OTHER,
          provider_ref: ref,
          provider_amount_paise: paise,
          razorpay_order_id: null,
          razorpay_amount_paise: null,
          currency_code: "inr",
          amount_paise: paise,
          superseded_at: new Date(),
          lines: (cart.items ?? []).map((i: any) => ({ id: i.id, variant_id: i.variant_id, quantity: 1, unit_price_paise: paise })),
        })
      }
      const hook = async (payment: { id: string; order_id: string; amount: number; currency: string; status: string }) => {
        const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { ...payment, notes: {} } } } })
        const signature = crypto.createHmac("sha256", razorpayWebhookSecret()).update(body).digest("hex")
        const res = await api.post("/hooks/payment/razorpay_razorpay", body, {
          headers: { "content-type": "application/json", "x-razorpay-signature": signature },
          transformRequest: [(d: unknown) => d],
        })
        return res.data
      }
      const waitFor = async (check: () => Promise<boolean>, ms = 20000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(300)
        }
        return false
      }

      // ── Razorpay, unchanged ────────────────────────────────────────

      it("records a Razorpay attempt in both the provider and the Razorpay columns", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        const [row] = await attemptsOf(cartId)
        expect(row).toMatchObject({
          provider_id: "pp_razorpay_razorpay",
          provider_ref: first.razorpayOrderId,
          razorpay_order_id: first.razorpayOrderId,
          provider_amount_paise: 200000,
          payment_session_id: first.sessionId,
          superseded_at: null,
        })
        razorpay.pay(first.razorpayOrderId)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
      })

      // ── Rows from the previous release ─────────────────────────────

      it("rows without the provider columns still guard, recover and resolve webhooks", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        await open(cartId)
        await makeLegacy(cartId)
        const late = razorpay.pay(first.razorpayOrderId)

        // Guard: a third payment is refused, because the legacy row is still read.
        const third = await openAttempt()(cartId)
        expect(third.ok).toBe(false)
        expect(third.message).toMatch(/already been paid/)
        // Webhook and settle recover it into the order.
        expect(await hook(late)).toMatchObject({ settling: true })
        expect(await waitFor(async () => (await orderAttempts(cartId))[0] === first.razorpayOrderId)).toBe(true)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
      })

      it("a refund owed on a row from the previous release is finished once, without a second row", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        const second = await open(cartId)
        razorpay.pay(second.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        const late = razorpay.pay(first.razorpayOrderId)
        razorpay.state.refund = "refuse"
        await settleLatePayments(container(), cartId, { complete: true })
        // As the previous release would have left it: only the Razorpay columns.
        await pg().raw(`UPDATE late_razorpay_payment SET provider_ref = NULL, provider_payment_ref = NULL WHERE cart_id = ?`, [cartId])
        await makeLegacy(cartId)

        razorpay.state.refund = "ok"
        await settleLatePayments(container(), cartId, { complete: true })
        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", razorpay_payment_id: late.id })])
      })

      // ── A second online provider ───────────────────────────────────

      it("a paid attempt with another provider blocks a new Razorpay payment, and is refunded through that provider only", async () => {
        const cartId = await preparedCart()
        await open(cartId)
        await otherAttempt(cartId, "txn_blocking")
        other.pay("txn_blocking", 200000)

        const blocked = await openAttempt()(cartId)
        expect(blocked.ok).toBe(false)
        expect(blocked.message).toMatch(/already been paid/)
        // The guard asked for a settle: the payment cannot go on a Razorpay session, so OtherPay refunds it.
        expect(await waitFor(async () => other.refunds.some((r) => r.payment_ref === "otp_txn_blocking"))).toBe(true)
        expect(await lateRows(cartId)).toEqual([
          expect.objectContaining({ provider_id: OTHER, provider_ref: "txn_blocking", provider_payment_ref: "otp_txn_blocking", razorpay_payment_id: null, status: "refunded", reason: "checkout_changed" }),
        ])
        expect(razorpay.refunds.filter((r) => r.payment_id === "otp_txn_blocking")).toHaveLength(0)

        // Being given back, so the customer can pay with Razorpay now.
        const retry = await openAttempt()(cartId)
        expect(retry.ok).toBe(true)
      })

      it("an order paid with Razorpay plus a late payment with another provider: that one is refunded once, the order untouched", async () => {
        const cartId = await preparedCart()
        const paid = await open(cartId)
        razorpay.pay(paid.razorpayOrderId)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        await otherAttempt(cartId, "txn_late")
        other.pay("txn_late", 200000)

        await Promise.all([
          settleLatePayments(container(), cartId, { complete: true }),
          settleLatePayments(container(), cartId, { complete: true }),
          complete(cartId),
        ])
        await settleLatePayments(container(), cartId, { complete: true })

        expect(other.refunds.filter((r) => r.payment_ref === "otp_txn_late")).toHaveLength(1)
        expect(other.refunds.find((r) => r.payment_ref === "otp_txn_late")).toMatchObject({ attempt_ref: "txn_late", amount: 2000, order_id: done.ok && done.data.order.id })
        expect(refundsOf(paid.razorpayOrderId)).toHaveLength(0)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ provider_id: OTHER, status: "refunded", reason: "ordered_otherwise" })])
      })

      it("the other provider down: nothing is decided for it; once it is back its payment is refunded", async () => {
        const cartId = await preparedCart()
        const paid = await open(cartId)
        razorpay.pay(paid.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        await otherAttempt(cartId, "txn_down")
        other.pay("txn_down", 200000)
        other.state.down = true

        await expect(settleLatePayments(container(), cartId, { complete: true })).rejects.toBeInstanceOf(GatewayUnavailableError)
        expect(await lateRows(cartId)).toHaveLength(0)
        expect(other.refunds.filter((r) => r.payment_ref === "otp_txn_down")).toHaveLength(0)

        other.state.down = false
        await settleLatePayments(container(), cartId, { complete: true })
        expect(other.refunds.filter((r) => r.payment_ref === "otp_txn_down")).toHaveLength(1)
      })

      it("the other provider refusing refunds: owed and retried, then handed to a person after five tries", async () => {
        const cartId = await preparedCart()
        const paid = await open(cartId)
        razorpay.pay(paid.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        await otherAttempt(cartId, "txn_refuse")
        other.pay("txn_refuse", 200000)
        other.state.refund = "refuse"

        for (let i = 0; i < 6; i++) await settleLatePayments(container(), cartId, { complete: true })
        const [row] = (await pg().raw(`SELECT status, refund_attempts, last_error FROM late_razorpay_payment WHERE cart_id = ?`, [cartId])).rows
        expect(row).toMatchObject({ status: "needs_review", refund_attempts: 5, last_error: "OtherPay refused" })
        expect(other.refunds.filter((r) => r.payment_ref === "otp_txn_refuse")).toHaveLength(0)
      })

      // ── One lock for every provider ────────────────────────────────

      it("opening a payment waits while the cart is being settled under the shared lock", async () => {
        const cartId = await preparedCart()
        const locking = container().resolve(Modules.LOCKING)
        let released = 0
        const held = locking.execute(checkoutLockKey(cartId), async () => {
          await wait(1500)
          released = Date.now()
        }, { timeout: 30 })
        await wait(100)
        const opened = await open(cartId)
        const finished = Date.now()
        await held
        expect(opened.razorpayOrderId).toBeTruthy()
        expect(finished).toBeGreaterThanOrEqual(released)
      })

      it("two payments opened at the same moment: one current attempt, the other superseded, never two current", async () => {
        const cartId = await preparedCart()
        const results = await Promise.all([openAttempt()(cartId), openAttempt()(cartId)])
        expect(results.every((r) => r.ok)).toBe(true)
        const rows = await attemptsOf(cartId)
        expect(rows).toHaveLength(2)
        expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1)
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.payment_sessions.id"], filters: { id: cartId } })
        const sessions = (data[0] as any).payment_collection.payment_sessions.map((s: any) => s.id)
        expect(sessions).toEqual([rows.find((r) => r.superseded_at === null).payment_session_id])
      })
      // ── Rolling deploy: a previous-release instance next to this one ──
      // The previous release took these locks itself, with these exact keys:
      // start-razorpay-checkout via acquireLockStep (retrying acquire every 0.3 s),
      // the late-payment settle via execute([checkout key, cart id]).

      const PREVIOUS_CHECKOUT_KEY = (cartId: string) => `razorpay-checkout:${cartId}`
      const previousWorkflowLock = async (key: string, timeoutMs = 10000) => {
        const locking = container().resolve(Modules.LOCKING)
        const until = Date.now() + timeoutMs
        for (;;) {
          try {
            await locking.acquire(key, { expire: 120 })
            return Date.now()
          } catch (error) {
            if (Date.now() >= until) throw error
            await wait(300)
          }
        }
      }
      const release = (keys: string | string[]) => container().resolve(Modules.LOCKING).release(keys)

      it("uses the same checkout lock key as the previous release", () => {
        expect(checkoutLockKey("cart_x")).toBe(PREVIOUS_CHECKOUT_KEY("cart_x"))
      })

      it("a previous-release instance opening a payment holds off this release's settle for that cart", async () => {
        const cartId = await preparedCart()
        await previousWorkflowLock(PREVIOUS_CHECKOUT_KEY(cartId))
        let released = 0
        const releaseLater = wait(1500).then(async () => {
          released = Date.now()
          await release(PREVIOUS_CHECKOUT_KEY(cartId))
        })
        await settleLatePayments(container(), cartId, { complete: true })
        const settledAt = Date.now()
        await releaseLater
        expect(released).toBeGreaterThan(0)
        expect(settledAt).toBeGreaterThanOrEqual(released)
      })

      it("a previous-release instance settling holds off this release's payment opening and the cart's completion", async () => {
        const cartId = await preparedCart()
        const locking = container().resolve(Modules.LOCKING)
        let released = 0
        const previousSettle = locking.execute([PREVIOUS_CHECKOUT_KEY(cartId), cartId], async () => {
          await wait(1500)
          released = Date.now()
        }, { timeout: 120 })
        await wait(100)
        const [opened, completed] = await Promise.all([
          open(cartId).then((r) => ({ ...r, at: Date.now() })),
          // Nothing paid, so completion is refused, but only after the lock is free.
          complete(cartId).then((r) => ({ ...r, at: Date.now() })),
        ])
        await previousSettle
        expect(opened.razorpayOrderId).toBeTruthy()
        expect(opened.at).toBeGreaterThanOrEqual(released)
        expect(completed.at).toBeGreaterThanOrEqual(released)
      })

      it("this release settling holds off a previous-release instance on the same cart, for both locks", async () => {
        const cartId = await preparedCart()
        await open(cartId)
        await otherAttempt(cartId, "txn_slow")
        other.state.delayMs = 1500 // keeps this release's settle inside its locks for a while

        const settling = settleLatePayments(container(), cartId, { complete: true }).then(() => Date.now())
        await wait(300)
        const [checkoutAt, cartAt] = await Promise.all([
          previousWorkflowLock(PREVIOUS_CHECKOUT_KEY(cartId)),
          previousWorkflowLock(cartId),
        ])
        const settledAt = await settling
        await release([PREVIOUS_CHECKOUT_KEY(cartId), cartId])
        expect(checkoutAt).toBeGreaterThanOrEqual(settledAt - 50)
        expect(cartAt).toBeGreaterThanOrEqual(settledAt - 50)
      })

      it("a previous-release instance and this one opening payments for the same cart never overlap", async () => {
        const cartId = await preparedCart()
        await open(cartId)
        const spans: [number, number][] = []
        const previous = (async () => {
          const start = await previousWorkflowLock(PREVIOUS_CHECKOUT_KEY(cartId))
          await wait(800)
          spans.push([start, Date.now()])
          await release(PREVIOUS_CHECKOUT_KEY(cartId))
        })()
        await wait(50)
        const current = (async () => {
          const started = Date.now()
          await open(cartId)
          spans.push([started, Date.now()])
        })()
        await Promise.all([previous, current])
        const [[aStart, aEnd]] = spans.slice(0, 1)
        const [[, bEnd]] = spans.slice(1)
        // The previous instance's hold ended before this release's opening could finish.
        expect(bEnd).toBeGreaterThanOrEqual(aEnd)
        expect(aEnd - aStart).toBeGreaterThanOrEqual(800)
        const rows = await attemptsOf(cartId)
        expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1)
      })
    })
  },
})
