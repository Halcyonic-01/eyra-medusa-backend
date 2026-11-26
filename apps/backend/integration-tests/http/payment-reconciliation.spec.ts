import crypto from "node:crypto"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils"
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  updateInventoryLevelsWorkflow,
  updateRegionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { ORDER_DISPATCH_MODULE } from "../../src/modules/order-dispatch"
import { PAYMENT_SNAPSHOT_MODULE } from "../../src/modules/payment-snapshot"
import { reconcileCurrentAttempts } from "../../src/modules/payment-snapshot/current-attempts"
import { settleLatePayments } from "../../src/modules/payment-snapshot/late-payments"
import { verifyCancellationRefunds, verifyLateRefunds } from "../../src/modules/payment-snapshot/refund-verification"
import { razorpayWebhookSecret } from "../../src/modules/payment-snapshot/webhook-guard"
import { checkoutFlow } from "./helpers/checkout-flow"
import { FAKE_PAYU_KEY, FAKE_PAYU_SALT, startFakePayu } from "./helpers/fake-payu"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

const PAYU_PORT = 19451
process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.PAYU_MERCHANT_KEY = FAKE_PAYU_KEY
process.env.PAYU_MERCHANT_SALT = FAKE_PAYU_SALT
process.env.PAYU_MODE = "test"
process.env.PAYU_API_URL = `http://127.0.0.1:${PAYU_PORT}/merchant/postservice.php?form=2`
process.env.PAYU_CHECKOUT_URL = ""
process.env.PAYU_SUCCESS_URL = "https://eyra.test/payu/ok"
process.env.PAYU_FAILURE_URL = "https://eyra.test/payu/no"
process.env.REFUND_GATEWAY = ""
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

// Phase 5: webhooks delivered twice or at once, webhooks never delivered,
// providers down, payments settling late, refunds the provider fails later.
// Razorpay and PayU are fakes over HTTP; everything else is the real backend.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const PAYU = "pp_payu_payu"
const RAZORPAY = "pp_razorpay_razorpay"

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Payment webhooks, reconciliation and recovery", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let payu: Awaited<ReturnType<typeof startFakePayu>>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19452)
        razorpay.attach(getContainer())
        payu = await startFakePayu(PAYU_PORT)
        await updateRegionsWorkflow(getContainer()).run({
          input: { selector: { id: fx.regionId }, update: { payment_providers: ["pp_system_default", RAZORPAY, PAYU] } },
        })
      })

      afterAll(async () => {
        await razorpay.close()
        await payu.close()
      })

      afterEach(() => {
        razorpay.state.down = false
        razorpay.state.refund = "ok"
        payu.state.down = false
        payu.state.refund = "ok"
      })

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
      const snapshots = () => container().resolve(PAYMENT_SNAPSHOT_MODULE) as any
      const address = {
        first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
        city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
      }

      const preparedCart = async (variantId: string = fx.variantByPrice[2000]) => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "prepaid")
        return cartId
      }
      const openRazorpay = async (cartId: string) => {
        const opened = await flow.must(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
        return opened.razorpay_order_id as string
      }
      const openPayu = async (cartId: string) =>
        (await flow.must(api.post(`/store/carts/${cartId}/payu-session`, {}, { headers: flow.headers }))) as {
          txnid: string
          form: { fields: Record<string, string> }
        }
      const ordersFor = async (cartId: string) => {
        const { data } = await query().graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
        return data.map((row: any) => row.order_id as string)
      }
      const captures = async (cartId: string) => {
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.payments.captures.id"], filters: { id: cartId } })
        return ((data[0] as any)?.payment_collection?.payments ?? []).flatMap((p: any) => p?.captures ?? []).length
      }
      const lateRows = async (cartId: string) =>
        (
          await pg().raw(
            `SELECT id, provider_id, status, reason, refund_id, refund_verified_at, last_error FROM late_razorpay_payment WHERE cart_id = ? AND deleted_at IS NULL ORDER BY created_at`,
            [cartId]
          )
        ).rows as any[]
      const events = async (key: string) =>
        (await pg().raw(`SELECT deliveries, duplicates, outcome FROM payment_webhook_event WHERE event_key = ?`, [key])).rows as any[]
      const refundsOf = (razorpayOrderId: string) => {
        const ids = new Set((razorpay.payments.get(razorpayOrderId) ?? []).map((p) => p.id))
        return razorpay.refunds.filter((r) => ids.has(r.payment_id))
      }
      /** Past the sweep's grace period, as if the customer paid a while ago. */
      const age = (cartId: string) => pg().raw(`UPDATE payment_price_snapshot SET created_at = created_at - interval '10 minutes' WHERE cart_id = ?`, [cartId])
      const waitFor = async (check: () => Promise<boolean>, ms = 25000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(300)
        }
        return false
      }
      const send = async (path: string, body: string, headers: Record<string, string>) => {
        try {
          const res = await api.post(path, body, { headers, transformRequest: [(d: unknown) => d] })
          return { status: res.status as number, data: res.data }
        } catch (error: any) {
          return { status: error.response?.status as number, data: error.response?.data }
        }
      }
      const razorpayHook = (payload: Record<string, unknown>, event = "payment.captured") => {
        const body = JSON.stringify({ event, payload })
        const signature = crypto.createHmac("sha256", razorpayWebhookSecret()).update(body).digest("hex")
        return send("/hooks/payment/razorpay_razorpay", body, { "content-type": "application/json", "x-razorpay-signature": signature })
      }
      const captured = (payment: { id: string; order_id: string; amount: number; currency: string; status: string }) =>
        razorpayHook({ payment: { entity: { ...payment, notes: {} } } })
      const payuHook = (fields: Record<string, string>) =>
        send("/hooks/payment/payu_payu", new URLSearchParams(fields).toString(), { "content-type": "application/x-www-form-urlencoded" })
      const payuSigned = (form: { fields: Record<string, string> }, status: string) =>
        payu.response({
          txnid: form.fields.txnid,
          amount: form.fields.amount,
          status,
          email: form.fields.email,
          firstname: form.fields.firstname,
          productinfo: form.fields.productinfo,
          udf1: form.fields.udf1,
        })
      const stockedVariant = async (quantity: number) => {
        const { data: profiles } = await query().graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query().graph({ entity: "stock_location", fields: ["id"] })
        const sku = `RECON-${Date.now()}`
        const { result: [product] } = await createProductsWorkflow(container()).run({
          input: {
            products: [
              {
                title: "Reconcile probe",
                handle: `reconcile-probe-${Date.now()}`,
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: (profiles[0] as any).id,
                sales_channels: [{ id: fx.salesChannelId }],
                options: [{ title: "Size", values: ["One"] }],
                variants: [{ title: "One", sku, manage_inventory: true, options: { Size: "One" }, prices: [{ amount: 2000, currency_code: "inr" }] }],
              },
            ],
          } as never,
        })
        const { data: items } = await query().graph({ entity: "inventory_item", fields: ["id"], filters: { sku } })
        const itemId = (items[0] as any).id as string
        const locationId = (locations[0] as any).id as string
        await createInventoryLevelsWorkflow(container()).run({
          input: { inventory_levels: [{ location_id: locationId, inventory_item_id: itemId, stocked_quantity: quantity }] },
        })
        return {
          variantId: (product as any).variants[0].id as string,
          setStock: (stocked_quantity: number) =>
            updateInventoryLevelsWorkflow(container()).run({ input: { updates: [{ inventory_item_id: itemId, location_id: locationId, stocked_quantity }] } }),
        }
      }
      /** A paid Razorpay cart whose stock ran out before anything confirmed it: the sweep refunds it. */
      const refundedByRazorpaySweep = async () => {
        const stocked = await stockedVariant(1)
        const cartId = await preparedCart(stocked.variantId)
        const orderId = await openRazorpay(cartId)
        razorpay.pay(orderId)
        await stocked.setStock(0)
        await age(cartId)
        const outcomes = await reconcileCurrentAttempts(container(), { providers: [RAZORPAY] })
        return { cartId, orderId, outcome: outcomes[orderId] }
      }

      // ── Duplicate and retried webhooks ──────────────────────────────

      it("a Razorpay capture delivered twice, then three times at once, is acted on once and places one order", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        const payment = razorpay.pay(orderId)

        const first = await captured(payment)
        expect(first).toMatchObject({ status: 200 })
        expect(first.data?.duplicate).toBeUndefined()
        expect(await captured(payment)).toMatchObject({ status: 200, data: { duplicate: "in_flight" } })
        const burst = await Promise.all([captured(payment), captured(payment), captured(payment)])
        expect(burst.map((r) => r.data?.duplicate)).toEqual(["in_flight", "in_flight", "in_flight"])

        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        await wait(6000)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await captures(cartId)).toBe(1)
        expect(await events(`payment.captured:${payment.id}`)).toEqual([expect.objectContaining({ deliveries: 5, duplicates: 4, outcome: "forwarded" })])

        // Long after, Razorpay retries again: the cart is the order already, so still nothing is done.
        await pg().raw(`UPDATE payment_webhook_event SET forwarded_at = now() - interval '1 hour' WHERE event_key = ?`, [`payment.captured:${payment.id}`])
        expect(await captured(payment)).toMatchObject({ status: 200, data: { duplicate: "already_recorded" } })
      })

      it("a redelivery after a delivery that never finished is handed on again and completes the order", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        const payment = razorpay.pay(orderId)
        // An earlier delivery was recorded 20 minutes ago, but its processing died: no order came of it.
        await snapshots().createPaymentWebhookEvents({
          provider_id: RAZORPAY,
          event_key: `payment.captured:${payment.id}`,
          event_type: "payment.captured",
          attempt_ref: orderId,
          cart_id: cartId,
          outcome: "forwarded",
          forwarded_at: new Date(Date.now() - 20 * 60 * 1000),
          last_seen_at: new Date(Date.now() - 20 * 60 * 1000),
        })

        const retried = await captured(payment)
        expect(retried.status).toBe(200)
        expect(retried.data?.duplicate).toBeUndefined()
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        expect(await events(`payment.captured:${payment.id}`)).toEqual([expect.objectContaining({ deliveries: 2, duplicates: 0 })])
      })

      it("when the delivery cannot be recorded the webhook is answered 503, so Razorpay retries, and the retry is handled", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        const payment = razorpay.pay(orderId)
        const spy = jest.spyOn(snapshots(), "listPaymentWebhookEvents").mockRejectedValueOnce(new Error("database unavailable"))

        expect((await captured(payment)).status).toBe(503)
        spy.mockRestore()
        await wait(6500)
        expect(await ordersFor(cartId)).toHaveLength(0)
        const retried = await captured(payment)
        expect(retried.status).toBe(200)
        expect(retried.data?.duplicate).toBeUndefined()
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
      })

      it("PayU: a pending notice then the success posted twice: each state handled once, one order", async () => {
        const cartId = await preparedCart()
        const opened = await openPayu(cartId)
        payu.pay(opened.txnid, opened.form.fields.amount, "pending")
        expect((await payuHook(payuSigned(opened.form, "pending"))).data?.duplicate).toBeUndefined()
        await wait(6500)
        expect(await ordersFor(cartId)).toHaveLength(0)

        payu.pay(opened.txnid, opened.form.fields.amount, "success")
        const success = payuSigned(opened.form, "success")
        expect((await payuHook(success)).data?.duplicate).toBeUndefined()
        expect(await payuHook(success)).toMatchObject({ status: 200, data: { duplicate: "in_flight" } })
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        await wait(6000)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await captures(cartId)).toBe(1)
      })

      // ── Missed confirmations ────────────────────────────────────────

      it("Razorpay paid but never confirmed: the sweep places the order once, records the capture, and a late webhook is not acted on", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        const payment = razorpay.pay(orderId)
        await age(cartId)

        expect((await reconcileCurrentAttempts(container()))[orderId]).toBe("completed")
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await captures(cartId)).toBe(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "recovered", reason: "missed_confirmation" })])

        await pg().raw(`UPDATE payment_price_snapshot SET reconciled_at = NULL WHERE cart_id = ?`, [cartId])
        expect((await reconcileCurrentAttempts(container()))[orderId]).toBe("skipped")
        expect(await captured(payment)).toMatchObject({ status: 200, data: { duplicate: "already_recorded" } })
        await wait(6000)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await captures(cartId)).toBe(1)
      })

      it("PayU still pending is left alone; once PayU settles it later, the sweep completes it", async () => {
        const cartId = await preparedCart()
        const opened = await openPayu(cartId)
        payu.pay(opened.txnid, opened.form.fields.amount, "pending")
        await age(cartId)

        expect((await reconcileCurrentAttempts(container()))[opened.txnid]).toBe("pending")
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(await lateRows(cartId)).toHaveLength(0)

        payu.pay(opened.txnid, opened.form.fields.amount, "success")
        await pg().raw(`UPDATE payment_price_snapshot SET reconciled_at = NULL WHERE cart_id = ?`, [cartId])
        expect((await reconcileCurrentAttempts(container()))[opened.txnid]).toBe("completed")
        expect(await ordersFor(cartId)).toHaveLength(1)
      })

      it("Razorpay down: nothing is decided or recorded; once it is back the paid cart is completed", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        razorpay.pay(orderId)
        await age(cartId)

        razorpay.state.down = true
        expect((await reconcileCurrentAttempts(container()))[orderId]).toBe("unavailable")
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(await lateRows(cartId)).toHaveLength(0)

        razorpay.state.down = false
        await pg().raw(`UPDATE payment_price_snapshot SET reconciled_at = NULL WHERE cart_id = ?`, [cartId])
        expect((await reconcileCurrentAttempts(container()))[orderId]).toBe("completed")
        expect(await ordersFor(cartId)).toHaveLength(1)
      })

      it("paid but the cart can no longer be completed (stock gone): refunded once, never ordered, never refunded twice", async () => {
        const { cartId, orderId, outcome } = await refundedByRazorpaySweep()
        expect(outcome).toBe("refused")
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(refundsOf(orderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", reason: expect.stringMatching(/^completion_refused/) })])

        await pg().raw(`UPDATE payment_price_snapshot SET reconciled_at = NULL WHERE cart_id = ?`, [cartId])
        await reconcileCurrentAttempts(container(), { providers: [RAZORPAY] })
        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(orderId)).toHaveLength(1)
        expect(await ordersFor(cartId)).toHaveLength(0)
      })

      it("paid a different amount than the attempt asked: no order, no refund, a person is asked", async () => {
        const cartId = await preparedCart()
        const orderId = await openRazorpay(cartId)
        razorpay.pay(orderId, { amount: 150000 })
        await age(cartId)

        expect((await reconcileCurrentAttempts(container()))[orderId]).toBe("mismatch")
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(refundsOf(orderId)).toHaveLength(0)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "needs_review", reason: "amount_mismatch" })])
      })

      // ── Refunds the provider fails later ────────────────────────────

      it("a refund Razorpay later fails is sent again exactly once, then followed until it is paid out", async () => {
        const { cartId, orderId } = await refundedByRazorpaySweep()
        const [first] = refundsOf(orderId)
        // Accepted, then failed at Razorpay days later (a closed account, a bank reversal).
        first.status = "failed"
        const verified = await verifyLateRefunds(container())
        expect(verified.failed).toBe(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunding", last_error: expect.stringContaining(first.id) })])

        await settleLatePayments(container(), cartId, { complete: true })
        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(orderId).map((r) => r.status)).toEqual(["failed", "processed"])
        const second = refundsOf(orderId)[1]
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", refund_id: second.id, refund_verified_at: null })])

        expect((await verifyLateRefunds(container())).processed).toBeGreaterThanOrEqual(1)
        expect((await lateRows(cartId))[0].refund_verified_at).not.toBeNull()
        await verifyLateRefunds(container())
        expect(refundsOf(orderId)).toHaveLength(2)
      })

      it("a signed Razorpay refund.failed notice checks that refund at once", async () => {
        const { cartId, orderId } = await refundedByRazorpaySweep()
        const [refund] = refundsOf(orderId)
        refund.status = "failed"

        expect(await razorpayHook({ refund: { entity: { id: refund.id, payment_id: refund.payment_id } } }, "refund.failed")).toMatchObject({
          status: 200,
          data: { checking_refund: true },
        })
        expect(await waitFor(async () => (await lateRows(cartId))[0]?.status === "refunding")).toBe(true)
        // An unsigned notice is refused and changes nothing.
        const unsigned = await send("/hooks/payment/razorpay_razorpay", JSON.stringify({ event: "refund.failed", payload: {} }), {
          "content-type": "application/json",
          "x-razorpay-signature": "00",
        })
        expect(unsigned.status).toBe(400)
      })

      it("a PayU refund PayU later fails is sent again under a new token, never the burned one", async () => {
        const stocked = await stockedVariant(1)
        const cartId = await preparedCart(stocked.variantId)
        const opened = await openPayu(cartId)
        payu.pay(opened.txnid, opened.form.fields.amount)
        await stocked.setStock(0)
        await age(cartId)
        expect((await reconcileCurrentAttempts(container(), { providers: [PAYU] }))[opened.txnid]).toBe("refused")
        expect(payu.refunds).toHaveLength(1)
        const burned = payu.refunds[0].token

        payu.refunds[0].status = "failure"
        expect((await verifyLateRefunds(container())).failed).toBe(1)
        await settleLatePayments(container(), cartId, { complete: true })
        await settleLatePayments(container(), cartId, { complete: true })
        expect(payu.refunds).toHaveLength(2)
        expect(payu.refunds[1].token).not.toBe(burned)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", refund_id: payu.refunds[1].request_id })])

        payu.refunds[1].status = "success"
        expect((await verifyLateRefunds(container())).processed).toBe(1)
        expect(await ordersFor(cartId)).toHaveLength(0)
      })

      it("a cancellation refund the provider failed becomes failed and needs attention; a paid-out one is marked verified", async () => {
        const placeOrder = async () => {
          const cartId = await preparedCart()
          const orderId = await openRazorpay(cartId)
          const payment = razorpay.pay(orderId)
          const done = await flow.must(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
          return { order: done.order.id as string, payment }
        }
        const service = container().resolve(ORDER_DISPATCH_MODULE) as any
        const cancellationFor = async (order: string, paymentId: string, status: string) => {
          const refund = { id: `rfnd_CANCEL${Date.now()}${status}`, entity: "refund" as const, payment_id: paymentId, amount: 200000, receipt: null, notes: {}, status, created_at: Math.floor(Date.now() / 1000) }
          razorpay.refunds.push(refund)
          return service.createOrderCancellations({
            order_id: order,
            refund_method: "original",
            refund_status: "initiated",
            status: "completed",
            razorpay_refund_id: refund.id,
            paid_online: 2000,
            refund_amount: 2000,
            completed_at: new Date(),
          })
        }
        const failedOrder = await placeOrder()
        const paidOrder = await placeOrder()
        const failed = await cancellationFor(failedOrder.order, failedOrder.payment.id, "failed")
        const paid = await cancellationFor(paidOrder.order, paidOrder.payment.id, "processed")

        const result = await verifyCancellationRefunds(container())
        expect(result).toMatchObject({ failed: 1, processed: 1 })
        expect(await service.retrieveOrderCancellation(failed.id)).toMatchObject({ refund_status: "failed", status: "needs_attention", refund_error: expect.stringContaining("failed") })
        expect((await service.retrieveOrderCancellation(paid.id)).refund_verified_at).not.toBeNull()
        // Nothing is re-checked once settled either way.
        expect((await verifyCancellationRefunds(container())).checked).toBe(0)
      })
    })
  },
})
