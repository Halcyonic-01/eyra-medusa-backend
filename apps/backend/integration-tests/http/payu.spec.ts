import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { loadCancellationContext } from "../../src/modules/order-dispatch/cancellation-context"
import { getRefundGateway } from "../../src/modules/order-dispatch/refund-gateway"
import { settleLatePayments } from "../../src/modules/payment-snapshot/late-payments"
import { requestHash } from "../../src/modules/payu-payment/hash"
import { reconcilePayuAttempts } from "../../src/modules/payu-payment/reconcile"
import { repairOrderPaymentWorkflow } from "../../src/workflows/repair-order-payment"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakePayu, FAKE_PAYU_KEY, FAKE_PAYU_SALT } from "./helpers/fake-payu"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

const PAYU_PORT = 19441
process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.PAYU_MERCHANT_KEY = FAKE_PAYU_KEY
process.env.PAYU_MERCHANT_SALT = FAKE_PAYU_SALT
process.env.PAYU_MODE = "test"
process.env.PAYU_API_URL = `http://127.0.0.1:${PAYU_PORT}/merchant/postservice.php?form=2`
process.env.PAYU_SUCCESS_URL = "https://eyra.test/payu/ok"
process.env.PAYU_FAILURE_URL = "https://eyra.test/payu/no"
process.env.REFUND_GATEWAY = ""
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

// PayU hosted checkout end to end against a fake PayU merchant API, next to
// Razorpay (also a fake) in the same region.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const PAYU = "pp_payu_payu"

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("PayU payment provider", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let payu: Awaited<ReturnType<typeof startFakePayu>>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        payu = await startFakePayu(PAYU_PORT)
        razorpay = await startFakeRazorpay(19442)
        razorpay.attach(getContainer())
        await updateRegionsWorkflow(getContainer()).run({
          input: { selector: { id: fx.regionId }, update: { payment_providers: ["pp_system_default", "pp_razorpay_razorpay", PAYU] } },
        })
      })

      afterAll(async () => {
        await payu.close()
        await razorpay.close()
      })

      afterEach(() => {
        payu.state.down = false
        payu.state.refund = "ok"
        razorpay.state.down = false
      })

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
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
        return { cartId, email: who.email }
      }
      const openPayu = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/payu-session`, {}, { headers: flow.headers }))
      const openRazorpay = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
      const mustOpenPayu = async (cartId: string) => {
        const opened = await openPayu(cartId)
        if (!opened.ok) throw new Error(`${opened.status} ${opened.message}`)
        return opened.data as { txnid: string; amount: number; payment_session_id: string; form: { action: string; fields: Record<string, string> } }
      }
      const complete = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
      /** What PayU posts back for the form, signed as PayU would. */
      const signed = (form: { fields: Record<string, string> }, status: string, over: Record<string, string> = {}) =>
        payu.response({
          txnid: form.fields.txnid,
          amount: form.fields.amount,
          status,
          email: form.fields.email,
          firstname: form.fields.firstname,
          productinfo: form.fields.productinfo,
          udf1: form.fields.udf1,
          ...over,
        })
      const returnFrom = (fields: Record<string, string>) => flow.attempt(api.post("/store/payu/return", fields, { headers: flow.headers }))
      const hook = async (fields: Record<string, string>) => {
        try {
          const res = await api.post("/hooks/payment/payu_payu", new URLSearchParams(fields).toString(), {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            transformRequest: [(d: unknown) => d],
          })
          return { status: res.status as number, data: res.data }
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
          fields: ["payment_collection.payments.provider_id", "payment_collection.payments.data", "payment_collection.payments.captures.id"],
          filters: { id: cartId },
        })
        return ((data[0] as any)?.payment_collection?.payments ?? []).filter(Boolean).map((p: any) => ({
          provider_id: p.provider_id,
          txnid: p.data?.payu?.txnid ?? p.data?.razorpayOrder?.id,
          captures: (p.captures ?? []).length,
        }))
      }
      const waitFor = async (check: () => Promise<boolean>, ms = 20000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(300)
        }
        return false
      }
      const age = (cartId: string) => pg().raw(`UPDATE payment_price_snapshot SET created_at = created_at - interval '10 minutes' WHERE cart_id = ?`, [cartId])

      // ── Opening a payment ───────────────────────────────────────────

      it("opens a PayU attempt and returns a hosted-checkout form signed with the session's own amount", async () => {
        const { cartId, email } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        expect(opened.amount).toBe(2000)
        expect(opened.form.action).toBe("https://test.payu.in/_payment")
        expect(opened.form.fields).toMatchObject({ key: FAKE_PAYU_KEY, txnid: opened.txnid, amount: "2000.00", email, phone: "9999999999", surl: "https://eyra.test/payu/ok", furl: "https://eyra.test/payu/no", udf1: cartId })
        expect(opened.form.fields.hash).toBe(requestHash(opened.form.fields as never, FAKE_PAYU_SALT))
        expect(JSON.stringify(opened)).not.toContain(FAKE_PAYU_SALT)
        expect(opened.txnid).toMatch(/^[a-zA-Z0-9]{1,25}$/)

        const [row] = (await pg().raw(`SELECT provider_id, provider_ref, provider_amount_paise, razorpay_order_id FROM payment_price_snapshot WHERE cart_id = ?`, [cartId])).rows
        expect(row).toEqual({ provider_id: PAYU, provider_ref: opened.txnid, provider_amount_paise: 200000, razorpay_order_id: null })
        // Nothing was asked of PayU to open it.
        expect(payu.calls.filter((c) => c.vars[0] === opened.txnid)).toHaveLength(0)
      })

      // ── Coming back from PayU ───────────────────────────────────────

      it("a paid return places the order once, from PayU's own record, however often it is repeated", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        const fields = signed(opened.form, "success")

        const [a, b] = await Promise.all([returnFrom(fields), returnFrom(fields)])
        const again = await returnFrom(fields)
        expect([a, b, again].map((r) => r.ok && r.data.status)).toEqual(["order", "order", "order"])
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await cartPayments(cartId)).toEqual([{ provider_id: PAYU, txnid: opened.txnid, captures: 1 }])
        expect(new Set([a, b, again].map((r) => r.ok && r.data.order_id)).size).toBe(1)
        expect(payu.refunds).toHaveLength(0)
      })

      it("a return saying 'success' is not believed when PayU's record says otherwise", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00", "failure")
        const res = await returnFrom(signed(opened.form, "success"))
        expect(res.ok && res.data.status).toBe("failed")
        expect(await ordersFor(cartId)).toHaveLength(0)
      })

      it("a tampered, foreign or unsigned return is refused", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        const fields = signed(opened.form, "success")
        expect((await returnFrom({ ...fields, amount: "1.00" })).status).toBe(400)
        expect((await returnFrom({ ...fields, hash: "0".repeat(128) })).status).toBe(400)
        expect((await returnFrom(payu.response({ txnid: "eyraUNKNOWN", amount: "2000.00", status: "success", email: "x@example.com", firstname: "X", productinfo: "EYRA order" }))).status).toBe(404)
        expect(await ordersFor(cartId)).toHaveLength(0)
      })

      // ── Pending and uncertain: never switch provider ────────────────

      it("while a PayU payment is pending, checkout cannot switch to Razorpay; once PayU confirms, the order is placed", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00", "pending")

        const back = await returnFrom(signed(opened.form, "pending"))
        expect(back.ok && back.data.status).toBe("pending")
        const switched = await openRazorpay(cartId)
        expect(switched.ok).toBe(false)
        expect(switched.message).toMatch(/PayU is still being confirmed/)
        expect(await ordersFor(cartId)).toHaveLength(0)

        payu.pay(opened.txnid, "2000.00", "success")
        expect((await hook(signed(opened.form, "success"))).status).toBe(200)
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        expect((await cartPayments(cartId))[0]).toMatchObject({ provider_id: PAYU, txnid: opened.txnid })
      })

      it("while a Razorpay payment is in progress, checkout cannot switch to PayU", async () => {
        const { cartId } = await preparedCart()
        const rzp = await openRazorpay(cartId)
        expect(rzp.ok).toBe(true)
        // A Razorpay payment that is neither captured nor failed yet.
        const order = rzp.ok ? (rzp.data.razorpay_order_id as string) : ""
        razorpay.payments.set(order, [{ id: "pay_PENDING", entity: "payment", order_id: order, amount: 200000, currency: "INR", status: "created" as never }])
        const switched = await openPayu(cartId)
        expect(switched.ok).toBe(false)
        expect(switched.message).toMatch(/Razorpay is still being confirmed/)
      })

      it("PayU unreachable: no order and no refund, the return asks to be retried, and switching to Razorpay is refused", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        payu.state.down = true
        const back = await returnFrom(signed(opened.form, "success"))
        expect(back.ok).toBe(false)
        expect(back.status).toBeGreaterThanOrEqual(500)
        const switched = await openRazorpay(cartId)
        expect(switched.ok).toBe(false)
        expect(switched.message).toMatch(/could not check your earlier payment/)
        expect(await ordersFor(cartId)).toHaveLength(0)

        payu.state.down = false
        const retry = await returnFrom(signed(opened.form, "success"))
        expect(retry.ok && retry.data.status).toBe("order")
      })

      // ── Webhooks ────────────────────────────────────────────────────

      it("a signed webhook places the order through Medusa, after PayU confirms it", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        expect((await hook(signed(opened.form, "success"))).status).toBe(200)
        // Medusa records the capture a moment before it links the order, so wait for both.
        expect(await waitFor(async () => (await cartPayments(cartId)).some((p) => p.captures === 1) && (await ordersFor(cartId)).length === 1)).toBe(true)
        // The browser coming back afterwards gets the same order.
        const back = await returnFrom(signed(opened.form, "success"))
        expect(back.ok && back.data.order_id).toBe((await ordersFor(cartId))[0])
      })

      it("an unsigned webhook is refused, a foreign one ignored, and a session id sent by a caller is dropped", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        const bad = await hook({ ...signed(opened.form, "success"), amount: "1.00" })
        expect(bad.status).toBe(400)
        const foreign = await hook(payu.response({ txnid: "eyraFOREIGN", amount: "5.00", status: "success", email: "x@example.com", firstname: "X", productinfo: "p" }))
        expect(foreign).toMatchObject({ status: 200, data: { reason: "no_snapshot" } })
        await wait(6500)
        expect(await ordersFor(cartId)).toHaveLength(0)

        // A genuine webhook carrying someone else's session id still only completes its own cart.
        const victim = await preparedCart()
        const victimSession = (await mustOpenPayu(victim.cartId)).payment_session_id
        expect((await hook({ ...signed(opened.form, "success"), eyra_session_id: victimSession })).status).toBe(200)
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        await wait(2000)
        expect(await ordersFor(victim.cartId)).toHaveLength(0)
      })

      // ── Nobody came back ────────────────────────────────────────────

      it("the PayU sweep completes a paid cart no return or webhook reached, and leaves pending ones", async () => {
        const paidCart = await preparedCart()
        const paid = await mustOpenPayu(paidCart.cartId)
        payu.pay(paid.txnid, "2000.00")
        const pendingCart = await preparedCart()
        const pending = await mustOpenPayu(pendingCart.cartId)
        payu.pay(pending.txnid, "2000.00", "pending")
        await age(paidCart.cartId)
        await age(pendingCart.cartId)

        const outcomes = await reconcilePayuAttempts(container())
        expect(outcomes[paid.txnid]).toBe("completed")
        expect(outcomes[pending.txnid]).toBe("pending")
        expect(await ordersFor(paidCart.cartId)).toHaveLength(1)
        expect(await ordersFor(pendingCart.cartId)).toHaveLength(0)
      })

      it("crash before the payment was recorded: the repair records it once PayU confirms it", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        payu.pay(opened.txnid, "2000.00")
        expect((await returnFrom(signed(opened.form, "success"))).ok).toBe(true)
        const [orderId] = await ordersFor(cartId)
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.id"], filters: { id: cartId } })
        const collectionId = (data[0] as any).payment_collection.id
        await pg().raw(`DELETE FROM capture WHERE payment_id IN (SELECT id FROM payment WHERE payment_collection_id = ?)`, [collectionId])
        await pg().raw(`DELETE FROM payment WHERE payment_collection_id = ?`, [collectionId])
        await pg().raw(`UPDATE payment_session SET status = 'pending', authorized_at = NULL WHERE payment_collection_id = ?`, [collectionId])

        const { result } = await repairOrderPaymentWorkflow(container()).run({ input: { order_id: orderId } })
        expect(result).toMatchObject({ action: "authorize", provider_id: PAYU })
        expect((await cartPayments(cartId)).map((p) => p.txnid)).toEqual([opened.txnid])
      })

      // ── Late payments and refunds ───────────────────────────────────

      it("a replaced PayU attempt paid late becomes the order (same provider, same transaction)", async () => {
        const { cartId } = await preparedCart()
        const first = await mustOpenPayu(cartId)
        await mustOpenPayu(cartId)
        payu.pay(first.txnid, "2000.00")

        const res = await hook(signed(first.form, "success"))
        expect(res.data).toMatchObject({ reason: "session_gone", settling: true })
        expect(await waitFor(async () => (await ordersFor(cartId)).length === 1)).toBe(true)
        expect(await waitFor(async () => (await cartPayments(cartId))[0]?.captures === 1)).toBe(true)
        expect(await cartPayments(cartId)).toEqual([{ provider_id: PAYU, txnid: first.txnid, captures: 1 }])
        expect(payu.refunds).toHaveLength(0)
      })

      it("a PayU payment arriving after the cart was ordered with Razorpay is refunded through PayU, once", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        const rzp = await openRazorpay(cartId)
        expect(rzp.ok).toBe(true)
        razorpay.pay(rzp.ok ? rzp.data.razorpay_order_id : "")
        expect((await complete(cartId)).ok).toBe(true)
        const late = payu.pay(opened.txnid, "2000.00")

        await Promise.all([hook(signed(opened.form, "success")), settleLatePayments(container(), cartId, { complete: true })])
        await waitFor(async () => payu.refunds.some((r) => r.mihpayid === late.mihpayid))
        await settleLatePayments(container(), cartId, { complete: true })
        expect(payu.refunds.filter((r) => r.mihpayid === late.mihpayid)).toEqual([expect.objectContaining({ amount: "2000.00" })])
        expect(razorpay.refunds).toHaveLength(0)
        expect((await cartPayments(cartId)).map((p) => p.provider_id)).toEqual(["pp_razorpay_razorpay"])
      })

      it("a cancellation of a PayU order is refunded to PayU, not Razorpay", async () => {
        const { cartId } = await preparedCart()
        const opened = await mustOpenPayu(cartId)
        const paid = payu.pay(opened.txnid, "2000.00")
        expect((await returnFrom(signed(opened.form, "success"))).ok).toBe(true)
        const [orderId] = await ordersFor(cartId)

        const context = await loadCancellationContext(container(), orderId)
        expect(context).toMatchObject({ online_provider_id: PAYU, attempt_ref: opened.txnid, has_online_payment: true, has_razorpay_payment: false, razorpay_order_id: null })
        const refund = await getRefundGateway(context!.online_provider_id!).refund({
          order_id: orderId, payment_ref: context!.payment_ref ?? null, attempt_ref: context!.attempt_ref ?? null,
          amount: 2000, fee: 0, cancellation_id: `ocnl_test_${orderId}`, since_ms: Date.now(),
        })
        expect(refund).toMatchObject({ ok: true })
        expect(payu.refunds.filter((r) => r.mihpayid === paid.mihpayid)).toHaveLength(1)
      })

      // ── Razorpay is untouched ───────────────────────────────────────

      it("Razorpay checkout in the same region works exactly as before, and PayU is never asked about it", async () => {
        const { cartId } = await preparedCart()
        const before = payu.calls.length
        const rzp = await openRazorpay(cartId)
        expect(rzp.ok).toBe(true)
        razorpay.pay(rzp.ok ? rzp.data.razorpay_order_id : "")
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect((await cartPayments(cartId)).map((p) => p.provider_id)).toEqual(["pp_razorpay_razorpay"])
        expect(payu.calls.length).toBe(before)
      })
    })
  },
})
