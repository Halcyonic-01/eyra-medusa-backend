import crypto from "node:crypto"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createPriceListsWorkflow,
  deletePriceListsWorkflow,
} from "@medusajs/medusa/core-flows"
import { loadPaymentStanding } from "../../src/modules/order-dispatch/payment-standing"
import { findReconcileCandidates } from "../../src/modules/order-dispatch/payment-reconcile"
import { razorpayWebhookSecret } from "../../src/modules/payment-snapshot/webhook-guard"
import { applyWalletToCartWorkflow } from "../../src/workflows/apply-wallet-to-cart"
import { createOrderDispatchWorkflow } from "../../src/workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../../src/workflows/dispatch-order"
import { issueWalletCreditWorkflow } from "../../src/workflows/issue-wallet-credit"
import { repairOrderPaymentWorkflow } from "../../src/workflows/repair-order-payment"
import reconcileOrderPayments from "../../src/jobs/reconcile-order-payments"
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

// Medusa's own Razorpay webhook next to the snapshot flow, and the states a
// crash part-way through cart completion leaves behind. Razorpay is a fake.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Razorpay webhook guard and crash recovery", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let admin: Record<string, string>
      let saleListId: string | null = null

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19433)
        razorpay.attach(getContainer())
        const {
          result: [key],
        } = await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
        admin = { Authorization: `Basic ${key.token}` }
      })

      afterAll(() => razorpay.close())

      afterEach(async () => {
        razorpay.state.down = false
        if (saleListId) {
          await deletePriceListsWorkflow(getContainer()).run({ input: { ids: [saleListId] } })
          saleListId = null
        }
      })

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
      const variant = () => fx.variantByPrice[2000]
      const address = {
        first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
        city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
      }

      const startSale = async () => {
        const { result } = await createPriceListsWorkflow(container()).run({
          input: {
            price_lists_data: [
              { title: `Sale ${Date.now()}`, description: "t", type: "sale", status: "active", prices: [{ amount: 1000, currency_code: "inr", variant_id: variant() }] } as never,
            ],
          },
        })
        saleListId = result[0].id
      }
      const endSale = async () => {
        if (!saleListId) return
        await deletePriceListsWorkflow(container()).run({ input: { ids: [saleListId] } })
        saleListId = null
      }

      const preparedCart = async (mode: "prepaid" | "cod" = "prepaid") => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: variant() }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, mode)
        return { cartId, email: who.email, customerId: who.id }
      }

      /** A prepaid cart with its Razorpay payment opened through the snapshot route. */
      const openPayment = async () => {
        const cart = await preparedCart()
        const opened = await flow.must(api.post(`/store/carts/${cart.cartId}/razorpay-session`, {}, { headers: flow.headers }))
        return { ...cart, razorpayOrderId: opened.razorpay_order_id as string, sessionId: opened.payment_session_id as string }
      }

      /** A COD cart left at the payment step, never completed by the customer. */
      const abandonedCodCart = async () => {
        const cart = await preparedCart("cod")
        const col = await flow.must(api.post("/store/payment-collections", { cart_id: cart.cartId }, { headers: flow.headers }))
        await flow.must(
          api.post(`/store/payment-collections/${col.payment_collection.id}/payment-sessions`, { provider_id: "pp_system_default" }, { headers: flow.headers })
        )
        return cart.cartId
      }

      const complete = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))

      const hook = async (
        payment: { id: string; order_id: string; amount: number; currency: string; status: string },
        options: { notes?: Record<string, string>; event?: string; signature?: string | null; provider?: string } = {}
      ) => {
        const body = JSON.stringify({ event: options.event ?? "payment.captured", payload: { payment: { entity: { ...payment, notes: options.notes ?? {} } } } })
        const signature = options.signature === undefined ? crypto.createHmac("sha256", razorpayWebhookSecret()).update(body).digest("hex") : options.signature
        try {
          const res = await api.post(`/hooks/payment/${options.provider ?? "razorpay_razorpay"}`, body, {
            headers: { "content-type": "application/json", ...(signature ? { "x-razorpay-signature": signature } : {}) },
            transformRequest: [(d: unknown) => d],
          })
          return { status: res.status, data: res.data }
        } catch (error: any) {
          return { status: error.response?.status as number, data: error.response?.data }
        }
      }

      const ordersFor = async (cartId: string) => {
        const { data } = await query().graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
        return data.map((row: any) => row.order_id as string)
      }

      const cartPayments = async (cartId: string) => {
        const { data } = await query().graph({
          entity: "cart",
          fields: [
            "completed_at",
            "payment_collection.payments.id",
            "payment_collection.payments.captured_at",
            "payment_collection.payments.captures.id",
            "payment_collection.payments.refunds.id",
          ],
          filters: { id: cartId },
        })
        const cart = data[0] as any
        const payments = (cart?.payment_collection?.payments ?? []).filter(Boolean)
        return {
          completed: Boolean(cart?.completed_at),
          payments: payments.length,
          captures: payments.reduce((n: number, p: any) => n + (p.captures ?? []).length, 0),
          refunds: payments.reduce((n: number, p: any) => n + (p.refunds ?? []).length, 0),
        }
      }

      const allCaptureCount = async () => Number((await pg().raw(`SELECT count(*)::int AS n FROM capture`)).rows[0].n)

      const waitFor = async (check: () => Promise<boolean>, ms = 20000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(500)
        }
        return false
      }

      /** What a crash between "order linked" and "payment authorized" leaves: an order with no payment record. */
      const crashBeforeAuthorization = async (cartId: string) => {
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.id"], filters: { id: cartId } })
        const collectionId = (data[0] as any).payment_collection.id as string
        await pg().raw(`DELETE FROM capture WHERE payment_id IN (SELECT id FROM payment WHERE payment_collection_id = ?)`, [collectionId])
        await pg().raw(`DELETE FROM payment WHERE payment_collection_id = ?`, [collectionId])
        await pg().raw(`UPDATE payment_session SET status = 'pending', authorized_at = NULL WHERE payment_collection_id = ?`, [collectionId])
        await pg().raw(`UPDATE payment_collection SET status = 'not_paid', authorized_amount = NULL, raw_authorized_amount = NULL WHERE id = ?`, [collectionId])
      }

      /** What a crash right after Medusa writes the order row leaves: an order linked to nothing. */
      const crashAfterOrderRow = async (email: string) => {
        const created = await container().resolve(Modules.ORDER).createOrders({
          region_id: fx.regionId,
          sales_channel_id: fx.salesChannelId,
          currency_code: "inr",
          email,
          status: "pending",
          items: [{ title: "Probe", variant_id: variant(), quantity: 1, unit_price: 2000 }],
        } as never)
        return (created as unknown as { id: string }).id
      }

      const dispatchClaim = async (orderId: string, force = true) => {
        await createOrderDispatchWorkflow(container()).run({ input: { order_id: orderId, window_minutes: 0 } })
        const { result } = await dispatchOrderWorkflow(container()).run({ input: { order_id: orderId, force } })
        return result
      }

      // ── Signature and matching ─────────────────────────────────────

      it("rejects a webhook with a bad or missing signature without processing it", async () => {
        const paid = await openPayment()
        const payment = razorpay.pay(paid.razorpayOrderId)
        const before = await allCaptureCount()

        expect((await hook(payment, { signature: "00".repeat(32) })).status).toBe(400)
        expect((await hook(payment, { signature: null })).status).toBe(400)
        await wait(7000)
        expect(await allCaptureCount()).toBe(before)
        expect((await cartPayments(paid.cartId)).completed).toBe(false)
      })

      it("answers 404 for any other payment provider's webhook", async () => {
        const res = await hook({ id: "pay_x", order_id: "order_x", amount: 100, currency: "INR", status: "captured" }, { provider: "system_default" })
        expect(res.status).toBe(404)
      })

      it("an unknown Razorpay order id is ignored and touches no other cart or payment", async () => {
        const abandoned = await abandonedCodCart()
        const paidElsewhere = await openPayment()
        razorpay.pay(paidElsewhere.razorpayOrderId)
        expect((await complete(paidElsewhere.cartId)).ok).toBe(true)
        const before = await allCaptureCount()

        const res = await hook({ id: "pay_ghost", order_id: "order_UNKNOWN", amount: 200000, currency: "INR", status: "captured" })
        expect(res.status).toBe(200)
        expect(res.data.reason).toBe("no_snapshot")
        await wait(7000)

        expect(await allCaptureCount()).toBe(before)
        expect(await ordersFor(abandoned)).toHaveLength(0)
        expect((await cartPayments(abandoned)).completed).toBe(false)
      })

      it("a payment opened without a snapshot (stock route) is ignored by the native webhook; the storefront path still completes it", async () => {
        const abandoned = await abandonedCodCart()
        const cart = await preparedCart()
        const col = await flow.must(api.post("/store/payment-collections", { cart_id: cart.cartId }, { headers: flow.headers }))
        const withSession = await flow.must(
          api.post(`/store/payment-collections/${col.payment_collection.id}/payment-sessions`, { provider_id: "pp_razorpay_razorpay" }, { headers: flow.headers })
        )
        const razorpayOrderId = withSession.payment_collection.payment_sessions[0].data.razorpayOrder.id
        const payment = razorpay.pay(razorpayOrderId)

        const res = await hook(payment)
        expect(res.data.reason).toBe("no_snapshot")
        await wait(7000)
        expect((await cartPayments(cart.cartId)).completed).toBe(false)
        expect(await ordersFor(abandoned)).toHaveLength(0)

        const done = await complete(cart.cartId)
        expect(done.ok && done.data.type).toBe("order")
      })

      it("a session id put in the notes by the browser is replaced with the backend's own", async () => {
        const victim = await openPayment()
        const buyer = await openPayment()
        const payment = razorpay.pay(buyer.razorpayOrderId)

        expect((await hook(payment, { notes: { session_id: victim.sessionId } })).status).toBe(200)
        expect(await waitFor(async () => (await ordersFor(buyer.cartId)).length === 1)).toBe(true)
        await wait(2000)
        const victimState = await cartPayments(victim.cartId)
        expect(victimState).toMatchObject({ completed: false, payments: 0 })
      })

      it("a late payment for a replaced session is ignored, and the new session is untouched", async () => {
        const first = await openPayment()
        const second = await flow.must(api.post(`/store/carts/${first.cartId}/razorpay-session`, {}, { headers: flow.headers }))
        expect(second.payment_session_id).not.toBe(first.sessionId)
        const late = razorpay.pay(first.razorpayOrderId)

        const res = await hook(late)
        expect(res.data.reason).toBe("session_gone")
        await wait(7000)
        expect(await cartPayments(first.cartId)).toMatchObject({ completed: false, payments: 0 })
      })

      // ── Webhook first, storefront first, duplicates ──────────────────

      it("webhook first (sale ended during payment): order at the paid price; the storefront then gets the same order", async () => {
        await startSale()
        const paid = await openPayment()
        await endSale()
        const payment = razorpay.pay(paid.razorpayOrderId)

        expect((await hook(payment)).status).toBe(200)
        expect(await waitFor(async () => (await ordersFor(paid.cartId)).length === 1)).toBe(true)
        const [orderId] = await ordersFor(paid.cartId)
        const { data } = await query().graph({ entity: "order", fields: ["total"], filters: { id: orderId } })
        expect(Number((data[0] as any).total)).toBe(1000)

        const storefront = await complete(paid.cartId)
        expect(storefront.ok && storefront.data.order.id).toBe(orderId)
        expect(await cartPayments(paid.cartId)).toMatchObject({ payments: 1, captures: 1, refunds: 0 })
        expect(razorpay.refunds).toHaveLength(0)
      })

      it("storefront first, then simultaneous and repeated webhooks: one order, one capture, no refund", async () => {
        const paid = await openPayment()
        const payment = razorpay.pay(paid.razorpayOrderId)
        const done = await complete(paid.cartId)
        expect(done.ok).toBe(true)

        const [a, b] = await Promise.all([hook(payment), hook(payment)])
        expect([a.status, b.status]).toEqual([200, 200])
        expect(await waitFor(async () => (await cartPayments(paid.cartId)).captures === 1)).toBe(true)
        await hook(payment)
        await wait(8000)

        expect(await ordersFor(paid.cartId)).toEqual([done.data.order.id])
        expect(await cartPayments(paid.cartId)).toMatchObject({ payments: 1, captures: 1, refunds: 0 })
        expect(razorpay.refunds).toHaveLength(0)
      })

      it("the webhook and the storefront completing at the same moment give one order", async () => {
        const paid = await openPayment()
        const payment = razorpay.pay(paid.razorpayOrderId)
        await hook(payment)
        await wait(4800) // Medusa processes the webhook about 5 s after it arrives
        const results = await Promise.all([complete(paid.cartId), complete(paid.cartId)])
        await waitFor(async () => (await cartPayments(paid.cartId)).captures === 1)
        await wait(3000)

        const ids = new Set(results.filter((r) => r.ok && r.data.type === "order").map((r) => r.data.order.id))
        expect(ids.size).toBeLessThanOrEqual(1)
        expect(await ordersFor(paid.cartId)).toHaveLength(1)
        expect((await cartPayments(paid.cartId)).refunds).toBe(0)
        expect(razorpay.refunds).toHaveLength(0)
      })

      // ── Crashes during completion ──────────────────────────────

      it("crash after the order row is written: the orphan is never shipped, the retry makes the real order", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const orphanId = await crashAfterOrderRow(paid.email)

        expect(await loadPaymentStanding(container(), orphanId)).toMatchObject({ ok: false, reason: "no_cart" })
        const held = await dispatchClaim(orphanId)
        expect(held).toMatchObject({ claimed: false, reason: "payment_not_confirmed" })

        const later = new Date(Date.now() + 10 * 60 * 1000)
        const { orphans } = await findReconcileCandidates(container(), later)
        expect(orphans.map((o) => o.order_id)).toContain(orphanId)

        const retry = await complete(paid.cartId)
        expect(retry.ok && retry.data.type).toBe("order")
        expect(retry.data.order.id).not.toBe(orphanId)
        expect(await loadPaymentStanding(container(), retry.data.order.id)).toMatchObject({ ok: true })
        expect(razorpay.refunds).toHaveLength(0)
      })

      it("crash before the payment is authorized: dispatch is held, reconcile records the payment once Razorpay confirms it", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const done = await complete(paid.cartId)
        const orderId = done.data.order.id as string
        await crashBeforeAuthorization(paid.cartId)

        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: false, reason: "no_payment_record" })
        expect(await dispatchClaim(orderId)).toMatchObject({ claimed: false, reason: "payment_not_confirmed" })

        // A retried completion returns the order but cannot repair it.
        const retried = await complete(paid.cartId)
        expect(retried.ok && retried.data.order.id).toBe(orderId)
        expect((await cartPayments(paid.cartId)).payments).toBe(0)

        const later = new Date(Date.now() + 10 * 60 * 1000)
        const { paymentless } = await findReconcileCandidates(container(), later)
        expect(paymentless.map((p) => p.order_id)).toContain(orderId)

        const { result } = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId } })
        expect(result.action).toBe("authorize")
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: true })

        const again = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId } })
        expect(again.result).toMatchObject({ action: "none", reason: "has_payment" })
        expect((await cartPayments(paid.cartId)).payments).toBe(1)
        expect(razorpay.refunds).toHaveLength(0)
      })

      it("crash before authorization, Razorpay shows no payment: nothing is recorded and the order stays held", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const done = await complete(paid.cartId)
        const orderId = done.data.order.id as string
        await crashBeforeAuthorization(paid.cartId)
        for (const p of razorpay.payments.get(paid.razorpayOrderId) ?? []) p.status = "failed"

        const { result } = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId } })
        expect(result).toMatchObject({ action: "unpaid", reason: "not_paid_at_razorpay" })
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: false })
        expect(await dispatchClaim(orderId)).toMatchObject({ claimed: false, reason: "payment_not_confirmed" })
      })

      it("crash before authorization, Razorpay unreachable: the repair waits and succeeds once it is back", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        await crashBeforeAuthorization(paid.cartId)

        razorpay.state.down = true
        const failed = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId }, throwOnError: false })
        expect(failed.errors?.[0]?.error?.message).toContain("Razorpay answered 503")
        expect((await cartPayments(paid.cartId)).payments).toBe(0)

        razorpay.state.down = false
        const { result } = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId } })
        expect(result.action).toBe("authorize")
      })

      it("crash before authorization, then Razorpay redelivers the webhook: Medusa records and captures the payment", async () => {
        const paid = await openPayment()
        const payment = razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        await crashBeforeAuthorization(paid.cartId)

        await hook(payment)
        expect(await waitFor(async () => (await cartPayments(paid.cartId)).captures === 1)).toBe(true)
        expect(await ordersFor(paid.cartId)).toEqual([orderId])
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: true })
      })

      it("the scheduled reconcile job repairs a crashed order on its own", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        await crashBeforeAuthorization(paid.cartId)
        await pg().raw(`UPDATE "order" SET created_at = now() - interval '10 minutes' WHERE id = ?`, [orderId])

        await reconcileOrderPayments(container())
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: true })
        await reconcileOrderPayments(container())
        expect((await cartPayments(paid.cartId)).payments).toBe(1)
      })

      it("two dispatchers racing for the same paid order: only one gets it", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: variant() }])
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)
        await createOrderDispatchWorkflow(container()).run({ input: { order_id: orderId, window_minutes: 0 } })
        const runs = await Promise.all([
          dispatchOrderWorkflow(container()).run({ input: { order_id: orderId, force: true } }),
          dispatchOrderWorkflow(container()).run({ input: { order_id: orderId, force: true } }),
        ])
        expect(runs.filter((r) => r.result.claimed)).toHaveLength(1)
      })

      // ── Confirmation records ────────────────────────────────────

      it("records the Razorpay ids on the order idempotently and only for this cart's own payment", async () => {
        const paid = await openPayment()
        const payment = razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        await container().resolve(Modules.ORDER).updateOrders({ id: orderId }, { metadata: { kept: "yes" } })

        const body = { cart_id: paid.cartId, razorpay_order_id: paid.razorpayOrderId, razorpay_payment_id: payment.id }
        const first = await flow.attempt(api.post("/admin/razorpay-confirmations", body, { headers: admin }))
        const second = await flow.attempt(api.post("/admin/razorpay-confirmations", body, { headers: admin }))
        expect(first.ok && first.data.order_id).toBe(orderId)
        expect(second.ok && second.data.order_id).toBe(orderId)

        const { data } = await query().graph({ entity: "order", fields: ["metadata"], filters: { id: orderId } })
        expect((data[0] as any).metadata).toMatchObject({ kept: "yes", razorpay_order_id: paid.razorpayOrderId, razorpay_payment_id: payment.id })

        const other = await openPayment()
        const wrongOrder = await flow.attempt(api.post("/admin/razorpay-confirmations", { ...body, razorpay_order_id: other.razorpayOrderId }, { headers: admin }))
        expect(wrongOrder).toMatchObject({ ok: false, status: 400 })
        const unpaid = await flow.attempt(api.post("/admin/razorpay-confirmations", { ...body, razorpay_payment_id: "pay_NOTPAID" }, { headers: admin }))
        expect(unpaid).toMatchObject({ ok: false, status: 400 })

        const secondPayment = razorpay.pay(paid.razorpayOrderId)
        const conflicting = await flow.attempt(api.post("/admin/razorpay-confirmations", { ...body, razorpay_payment_id: secondPayment.id }, { headers: admin }))
        expect(conflicting).toMatchObject({ ok: false, status: 409 })

        const notYet = await flow.attempt(api.post("/admin/razorpay-confirmations", { ...body, cart_id: other.cartId, razorpay_order_id: other.razorpayOrderId }, { headers: admin }))
        expect(notYet).toMatchObject({ ok: false, status: 404 })

        const noAuth = await flow.attempt(api.post("/admin/razorpay-confirmations", body))
        expect(noAuth).toMatchObject({ ok: false, status: 401 })
      })

      it("the confirmation email can be claimed once, even by simultaneous callers", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        const gate = (action: string) => flow.must(api.post(`/admin/orders/${orderId}/confirmation-email`, { action }, { headers: admin }))

        const claims = await Promise.all([gate("claim"), gate("claim"), gate("claim")])
        expect(claims.filter((c: any) => c.claimed)).toHaveLength(1)

        await gate("release")
        expect((await gate("claim")).claimed).toBe(true)

        // A sender that died: its claim expires after ten minutes.
        await pg().raw(
          `UPDATE "order" SET metadata = metadata || jsonb_build_object('confirmation_email_claimed_at', (now() - interval '11 minutes')::text) WHERE id = ?`,
          [orderId]
        )
        expect((await gate("claim")).claimed).toBe(true)

        await gate("sent")
        expect(await gate("claim")).toEqual({ claimed: false, already_sent: true })
        await gate("release")
        expect(await gate("claim")).toEqual({ claimed: false, already_sent: true })
      })

      // ── Cash on Delivery and wallet orders ───────────────────────

      it("Cash on Delivery orders are shippable and left alone by reconcile", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: variant() }])
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)

        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: true, kind: "paid" })
        const claim = await dispatchClaim(orderId)
        expect(claim.reason).not.toBe("payment_not_confirmed")
        const later = new Date(Date.now() + 10 * 60 * 1000)
        const { paymentless, orphans } = await findReconcileCandidates(container(), later)
        expect(paymentless.map((p) => p.order_id)).not.toContain(orderId)
        expect(orphans.map((o) => o.order_id)).not.toContain(orderId)
      })

      it("an order paid in full by wallet credit is shippable", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1000] }])
        await issueWalletCreditWorkflow(container()).run({ input: { customer_id: who.id, amount: 5000, reason: "return" } })
        await flow.setMode(cartId, "prepaid")
        await applyWalletToCartWorkflow(container()).run({ input: { cart_id: cartId, customer_id: who.id } })
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")

        expect(await loadPaymentStanding(container(), done.data.order.id)).toMatchObject({ ok: true })
        expect((await dispatchClaim(done.data.order.id)).reason).not.toBe("payment_not_confirmed")
      })

      it("an unpaid order is held even with Ship now, and its window moves out instead of using up attempts", async () => {
        const paid = await openPayment()
        razorpay.pay(paid.razorpayOrderId)
        const orderId = (await complete(paid.cartId)).data.order.id as string
        await crashBeforeAuthorization(paid.cartId)

        const first = await dispatchClaim(orderId, true)
        const second = await dispatchClaim(orderId, true)
        expect(second).toMatchObject({ claimed: false, reason: "payment_not_confirmed" })
        expect(first.dispatch?.attempts ?? 0).toBe(0)
        expect(second.dispatch?.attempts ?? 0).toBe(0)
        expect(new Date(second.dispatch!.window_ends_at).getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 1000)
        expect(second.dispatch?.last_error).toContain("No payment is recorded")
      })
    })
  },
})
