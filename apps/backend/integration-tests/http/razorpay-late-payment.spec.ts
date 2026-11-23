import crypto from "node:crypto"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils"
import { createInventoryLevelsWorkflow, createProductsWorkflow, updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows"
import reconcileLatePayments from "../../src/jobs/reconcile-late-payments"
import { findLatePaymentCarts } from "../../src/modules/payment-snapshot/late-candidates"
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

// A Razorpay attempt replaced by a newer one can still be paid later. Razorpay is a fake.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Late payment on a replaced Razorpay attempt", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19437)
        razorpay.attach(getContainer())
      })

      afterAll(() => razorpay.close())

      afterEach(async () => {
        razorpay.state.down = false
        razorpay.state.refund = "ok"
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
        return cartId
      }

      const open = async (cartId: string) => {
        const opened = await flow.must(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
        return { razorpayOrderId: opened.razorpay_order_id as string, sessionId: opened.payment_session_id as string }
      }

      const complete = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))

      const hook = async (payment: { id: string; order_id: string; amount: number; currency: string; status: string }) => {
        const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { ...payment, notes: {} } } } })
        const signature = crypto.createHmac("sha256", razorpayWebhookSecret()).update(body).digest("hex")
        try {
          const res = await api.post("/hooks/payment/razorpay_razorpay", body, {
            headers: { "content-type": "application/json", "x-razorpay-signature": signature },
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

      /** The Razorpay order behind the payment recorded on the cart's order. */
      const orderRazorpayOrder = async (cartId: string) => {
        const { data } = await query().graph({
          entity: "cart",
          fields: ["payment_collection.payments.data", "payment_collection.payments.captures.id"],
          filters: { id: cartId },
        })
        const payments = ((data[0] as any)?.payment_collection?.payments ?? []).filter(Boolean)
        return {
          payments: payments.length,
          captures: payments.reduce((n: number, p: any) => n + (p.captures ?? []).length, 0),
          razorpay_order_ids: payments.map((p: any) => p.data?.razorpayOrder?.id),
        }
      }

      /** What the backend recorded about late payments on a cart. */
      const lateRows = async (cartId: string) =>
        (await pg().raw(`SELECT status, reason, order_id, refund_id, refund_attempts, razorpay_order_id FROM late_razorpay_payment WHERE cart_id = ? AND deleted_at IS NULL`, [cartId])).rows as any[]

      const refundsOf = (razorpayOrderId: string) => {
        const ids = new Set((razorpay.payments.get(razorpayOrderId) ?? []).map((p) => p.id))
        return razorpay.refunds.filter((r) => ids.has(r.payment_id))
      }

      const waitFor = async (check: () => Promise<boolean>, ms = 20000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(300)
        }
        return false
      }

      /** Makes a cart's attempts look older than the job's grace period. */
      const age = (cartId: string) =>
        pg().raw(
          `UPDATE payment_price_snapshot SET created_at = created_at - interval '10 minutes', late_checked_at = late_checked_at - interval '10 minutes' WHERE cart_id = ?`,
          [cartId]
        )

      /** A product whose stock is counted, so completion can run out of it. */
      const stockedVariant = async (quantity: number) => {
        const { data: profiles } = await query().graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query().graph({ entity: "stock_location", fields: ["id"] })
        const sku = `LATE-${Date.now()}`
        const { result: [product] } = await createProductsWorkflow(container()).run({
          input: {
            products: [
              {
                title: "Late probe",
                handle: `late-probe-${Date.now()}`,
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

      /** A cart with two Razorpay attempts; the first was replaced by the second. */
      const twoAttempts = async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        const second = await open(cartId)
        return { cartId, first, second }
      }

      it("reproduction: the older attempt paid late becomes the order, nothing is lost or refunded", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        const second = await open(cartId)
        expect(second.sessionId).not.toBe(first.sessionId)

        const late = razorpay.pay(first.razorpayOrderId)
        expect((await hook(late)).status).toBe(200)
        const done = await complete(cartId)

        expect(done.ok && done.data.type).toBe("order")
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ payments: 1, razorpay_order_ids: [first.razorpayOrderId] })
        await wait(1000)
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
      })
      it("browser verify only (no webhook): completing the cart uses the late payment", async () => {
        const { cartId, first, second } = await twoAttempts()
        razorpay.pay(first.razorpayOrderId)

        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ payments: 1, razorpay_order_ids: [first.razorpayOrderId] })
        // The job records the capture the swallowed notice would have.
        await settleLatePayments(container(), cartId, { complete: true })
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ captures: 1 })
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "recovered", order_id: done.data.order.id })])
        expect(razorpay.orders.get(first.razorpayOrderId)!.notes.medusa_payment_session_id).toBe(second.sessionId)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "recovered", razorpay_order_id: first.razorpayOrderId })])
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
      })

      it("every path at once (webhook, two completions, settle, job): one order, one payment, no refund", async () => {
        const { cartId, first } = await twoAttempts()
        const late = razorpay.pay(first.razorpayOrderId)
        await age(cartId)

        const results = await Promise.all([
          hook(late),
          complete(cartId),
          complete(cartId),
          settleLatePayments(container(), cartId, { complete: true }),
          reconcileLatePayments(container()),
        ])
        await waitFor(async () => (await ordersFor(cartId)).length === 1)
        await wait(3000)
        await hook(late)
        await complete(cartId)
        await wait(2000)

        const orderIds = new Set((results.slice(1, 3) as any[]).filter((r) => r.ok).map((r) => r.data.order.id))
        expect(orderIds.size).toBeLessThanOrEqual(1)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ payments: 1, captures: 1, razorpay_order_ids: [first.razorpayOrderId] })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
        expect((await lateRows(cartId)).map((r) => r.status)).toEqual(["recovered"])
      })

      it("both attempts paid: the current one is the order, the late one is refunded exactly once", async () => {
        const { cartId, first, second } = await twoAttempts()
        razorpay.pay(second.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        const late = razorpay.pay(first.razorpayOrderId)

        expect((await hook(late)).data).toMatchObject({ reason: "session_gone", settling: true })
        expect(await waitFor(async () => refundsOf(first.razorpayOrderId).length === 1)).toBe(true)
        await Promise.all([hook(late), settleLatePayments(container(), cartId, { complete: true })])
        await age(cartId)
        await reconcileLatePayments(container())
        await wait(2000)

        expect(refundsOf(first.razorpayOrderId)).toEqual([expect.objectContaining({ amount: late.amount })])
        expect(refundsOf(second.razorpayOrderId)).toHaveLength(0)
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ payments: 1, razorpay_order_ids: [second.razorpayOrderId] })
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", reason: "ordered_otherwise", refund_attempts: 1 })])
      })

      it("after a recovery, the replaced attempt's own payment arriving later is refunded", async () => {
        const { cartId, first, second } = await twoAttempts()
        razorpay.pay(first.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)

        const latest = razorpay.pay(second.razorpayOrderId)
        expect((await hook(latest)).data).toMatchObject({ reason: "session_mismatch", settling: true })
        expect(await waitFor(async () => refundsOf(second.razorpayOrderId).length === 1)).toBe(true)
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
        expect(await ordersFor(cartId)).toHaveLength(1)
      })

      it("cart changed after the first attempt: its late payment is refunded and the new attempt still works", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        await flow.must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: variant(), quantity: 1 }, { headers: flow.headers }))
        const second = await open(cartId)
        expect(razorpay.orders.get(second.razorpayOrderId)!.amount).not.toBe(razorpay.orders.get(first.razorpayOrderId)!.amount)

        razorpay.pay(first.razorpayOrderId)
        await hook(razorpay.payments.get(first.razorpayOrderId)![0])
        expect(await waitFor(async () => refundsOf(first.razorpayOrderId).length === 1)).toBe(true)
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", reason: "cart_changed" })])

        razorpay.pay(second.razorpayOrderId)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ razorpay_order_ids: [second.razorpayOrderId] })
      })

      it("switched to Cash on Delivery: the order is COD and the late prepaid payment is refunded by the job", async () => {
        const cartId = await preparedCart()
        const first = await open(cartId)
        await flow.setMode(cartId, "cod")
        const { data } = await query().graph({ entity: "cart", fields: ["payment_collection.id"], filters: { id: cartId } })
        await flow.must(
          api.post(`/store/payment-collections/${(data[0] as any).payment_collection.id}/payment-sessions`, { provider_id: "pp_system_default" }, { headers: flow.headers })
        )
        expect((await complete(cartId)).ok).toBe(true)

        razorpay.pay(first.razorpayOrderId)
        await age(cartId)
        expect(await findLatePaymentCarts(container())).toContain(cartId)
        await reconcileLatePayments(container())

        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", reason: "ordered_otherwise" })])
        expect(await ordersFor(cartId)).toHaveLength(1)
      })

      it("a new payment is refused while a replaced attempt is paid, and that payment becomes the order", async () => {
        const { cartId, first } = await twoAttempts()
        razorpay.pay(first.razorpayOrderId)

        const third = await flow.attempt(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
        expect(third.ok).toBe(false)
        expect(third.message).toMatch(/already been paid/)
        // The order is linked a moment before its payment is recorded.
        expect(await waitFor(async () => (await orderRazorpayOrder(cartId)).payments === 1)).toBe(true)
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ razorpay_order_ids: [first.razorpayOrderId] })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
      })

      it("Razorpay down while settling: nothing is decided or refunded; once it is back the job recovers the order", async () => {
        const { cartId, first } = await twoAttempts()
        const late = razorpay.pay(first.razorpayOrderId)
        razorpay.state.down = true

        expect((await hook(late)).status).toBe(200)
        const refused = await complete(cartId)
        expect(refused.ok && refused.data.type).not.toBe("order")
        await wait(2000)
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(await lateRows(cartId)).toHaveLength(0)

        razorpay.state.down = false
        await age(cartId)
        await reconcileLatePayments(container())
        expect(await ordersFor(cartId)).toHaveLength(1)
        expect(await orderRazorpayOrder(cartId)).toMatchObject({ razorpay_order_ids: [first.razorpayOrderId] })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
      })

      it("a refund Razorpay refuses stays owed and is sent once by a later run", async () => {
        const { cartId, first, second } = await twoAttempts()
        razorpay.pay(second.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        razorpay.pay(first.razorpayOrderId)
        razorpay.state.refund = "refuse"

        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunding", refund_attempts: 1 })])

        razorpay.state.refund = "ok"
        await age(cartId)
        await reconcileLatePayments(container())
        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", refund_attempts: 2 })])
      })

      it("a refund whose answer is lost is found again, never sent twice", async () => {
        const { cartId, first, second } = await twoAttempts()
        razorpay.pay(second.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        razorpay.pay(first.razorpayOrderId)
        razorpay.state.refund = "lost"

        await settleLatePayments(container(), cartId, { complete: true })
        razorpay.state.refund = "ok"
        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded" })])
      })

      it("a recovered payment the cart can no longer take (out of stock) is refunded, with no order", async () => {
        const stocked = await stockedVariant(1)
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: stocked.variantId }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "prepaid")
        const first = await open(cartId)
        await open(cartId)
        razorpay.pay(first.razorpayOrderId)
        await stocked.setStock(0)

        const result = await settleLatePayments(container(), cartId, { complete: true })
        expect(result.recovered).toBe(true)
        expect(await ordersFor(cartId)).toHaveLength(0)
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "refunded", reason: expect.stringMatching(/^completion_refused/) })])

        // Razorpay still calls the refunded order "paid": the cart must not be able to complete with it.
        await stocked.setStock(1)
        await settleLatePayments(container(), cartId, { complete: true })
        const retry = await complete(cartId)
        expect(retry.ok && retry.data.type).not.toBe("order")
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(1)
        expect(await ordersFor(cartId)).toHaveLength(0)
      })

      it("a refund owed is never sent for the payment the cart's order was placed with", async () => {
        const { cartId, first } = await twoAttempts()
        razorpay.pay(first.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        // As if an earlier run had wrongly decided to refund it.
        await pg().raw(`UPDATE late_razorpay_payment SET status = 'refunding', order_id = NULL WHERE cart_id = ?`, [cartId])

        await settleLatePayments(container(), cartId, { complete: true })
        expect(refundsOf(first.razorpayOrderId)).toHaveLength(0)
        expect(await lateRows(cartId)).toEqual([expect.objectContaining({ status: "recovered", order_id: (await ordersFor(cartId))[0] })])
      })

      it("an unpaid replaced attempt is left alone", async () => {
        const { cartId, second } = await twoAttempts()
        const result = await settleLatePayments(container(), cartId, { complete: true })
        expect(result).toMatchObject({ checked: 1, recovered: false, refunded: 0 })
        razorpay.pay(second.razorpayOrderId)
        expect((await complete(cartId)).ok).toBe(true)
        expect(await lateRows(cartId)).toHaveLength(0)
        expect(refundsOf(second.razorpayOrderId)).toHaveLength(0)
      })
    })
  },
})
