import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPriceListsWorkflow, deletePriceListsWorkflow } from "@medusajs/medusa/core-flows"
import { PAYMENT_SNAPSHOT_MODULE } from "../../src/modules/payment-snapshot"
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

jest.setTimeout(240000)

// A sale price list puts the ₹2,000 probe variant at ₹1,000. Each test opens a
// Razorpay payment during the sale, ends the sale, and then decides what the
// customer did at Razorpay. Razorpay itself is an in-process fake.

const REGULAR = 2000
const SALE = 1000

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Razorpay payments keep the price the customer agreed to", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let saleListId: string | null = null

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19431)
        razorpay.attach(getContainer())
      })

      afterAll(async () => {
        await razorpay.close()
      })

      afterEach(async () => {
        await endSale()
        razorpay.state.down = false
      })

      const variant = () => fx.variantByPrice[REGULAR]

      const startSale = async (amount = SALE) => {
        const { result } = await createPriceListsWorkflow(getContainer()).run({
          input: {
            price_lists_data: [
              {
                title: `Test sale ${Date.now()}`,
                description: "integration",
                type: "sale",
                status: "active",
                prices: [{ amount, currency_code: "inr", variant_id: variant() }],
              } as never,
            ],
          },
        })
        saleListId = result[0].id
      }

      const endSale = async () => {
        if (!saleListId) return
        await deletePriceListsWorkflow(getContainer()).run({ input: { ids: [saleListId] } })
        saleListId = null
      }

      /** What the storefront does before opening Razorpay: address, prepaid charge. */
      const prepare = async (cartId: string, email: string) => {
        await flow.must(
          api.post(
            `/store/carts/${cartId}`,
            {
              email,
              shipping_address: {
                first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
                city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
              },
            },
            { headers: flow.headers }
          )
        )
        await flow.setMode(cartId, "prepaid")
      }

      const openRazorpay = (cartId: string) =>
        flow.attempt(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))

      const complete = (cartId: string) =>
        flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))

      /** A prepaid cart with the probe item and a Razorpay payment opened, during a sale. */
      const paymentOpenedDuringSale = async () => {
        await startSale()
        const customer = await flow.customer()
        const cartId = await flow.cart(customer.email, [{ variantId: variant() }])
        await prepare(cartId, customer.email)
        const opened = await openRazorpay(cartId)
        if (!opened.ok) throw new Error(`could not open Razorpay: ${opened.status} ${opened.message}`)
        return { cartId, opened: opened.data as { razorpay_order_id: string; amount: number; payment_session_id: string } }
      }

      const ordersForCart = async (cartId: string) => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
        return data.map((row: any) => row.order_id as string)
      }

      const orderLines = async (orderId: string) => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "order",
          fields: ["id", "total", "items.unit_price", "items.variant_id", "items.quantity", "items.detail.quantity"],
          filters: { id: orderId },
        })
        const order = data[0] as any
        return {
          total: Number(order.total),
          probe: order.items.find((item: any) => item.variant_id === variant()),
        }
      }

      const medusaRefunds = async (orderId: string) => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "order",
          fields: ["payment_collections.payments.refunds.id"],
          filters: { id: orderId },
        })
        return ((data[0] as any).payment_collections ?? []).flatMap((c: any) =>
          (c.payments ?? []).flatMap((p: any) => p.refunds ?? [])
        )
      }

      it("records a snapshot at the sale price when the payment opens", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        expect(opened.amount).toBe(SALE)
        expect(razorpay.orders.get(opened.razorpay_order_id)?.amount).toBe(SALE * 100)

        const service = getContainer().resolve(PAYMENT_SNAPSHOT_MODULE) as any
        const [snapshot] = await service.listPaymentPriceSnapshots({ cart_id: cartId })
        expect(snapshot).toMatchObject({
          payment_session_id: opened.payment_session_id,
          razorpay_order_id: opened.razorpay_order_id,
          amount_paise: SALE * 100,
          razorpay_amount_paise: SALE * 100,
        })
      })

      it("successful capture with no price change places the order", async () => {
        const customer = await flow.customer()
        const cartId = await flow.cart(customer.email, [{ variantId: variant() }])
        await prepare(cartId, customer.email)
        const opened = await openRazorpay(cartId)
        expect(opened.ok).toBe(true)
        expect(opened.data.amount).toBe(REGULAR)

        razorpay.pay(opened.data.razorpay_order_id)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect((await orderLines(done.data.order.id)).total).toBe(REGULAR)
      })

      it("sale ends during payment: the captured payment becomes an order at the sale price", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id)

        const done = await complete(cartId)
        expect(done.ok).toBe(true)
        expect(done.data.type).toBe("order")
        const order = await orderLines(done.data.order.id)
        expect(order.total).toBe(SALE)
        expect(Number(order.probe.unit_price)).toBe(SALE)
        expect(razorpay.refunds).toHaveLength(0)
      })

      it("checkout pricing does not reprice a cart that is already paid", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id)

        const summary = await flow.setMode(cartId, "prepaid")
        expect(summary.totals.items_subtotal).toBe(SALE)

        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect((await orderLines(done.data.order.id)).total).toBe(SALE)
      })

      it("failed payment: completion is refused and the next try is at today's price", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id, { status: "failed" })

        const refused = await complete(cartId)
        expect(refused.ok).toBe(false)
        expect(refused.status).toBe(400)
        expect(refused.message).toContain("Prices in your cart have changed")
        expect(await ordersForCart(cartId)).toHaveLength(0)

        // The customer tries again: checkout pricing reprices, a new payment opens at ₹2,000.
        const summary = await flow.setMode(cartId, "prepaid")
        expect(summary.totals.items_subtotal).toBe(REGULAR)
        const retry = await openRazorpay(cartId)
        expect(retry.ok).toBe(true)
        expect(retry.data.amount).toBe(REGULAR)
        expect(retry.data.razorpay_order_id).not.toBe(opened.razorpay_order_id)

        razorpay.pay(retry.data.razorpay_order_id)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect((await orderLines(done.data.order.id)).total).toBe(REGULAR)
      })

      it("cancelled payment (nothing paid): completion at the old price is refused", async () => {
        const { cartId } = await paymentOpenedDuringSale()
        await endSale()
        const refused = await complete(cartId)
        expect(refused.ok).toBe(false)
        expect(refused.message).toContain("Prices in your cart have changed")
      })

      it("a new payment is opened at today's price even if the storefront skipped repricing", async () => {
        await startSale()
        const customer = await flow.customer()
        const cartId = await flow.cart(customer.email, [{ variantId: variant() }])
        await prepare(cartId, customer.email)
        await endSale()

        const opened = await openRazorpay(cartId)
        expect(opened.ok).toBe(true)
        expect(opened.data.amount).toBe(REGULAR)
      })

      it("amount mismatch: a short payment is not honoured", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id, { amount: SALE * 100 - 100 })

        const refused = await complete(cartId)
        expect(refused.ok).toBe(false)
        expect(await ordersForCart(cartId)).toHaveLength(0)
      })

      it("amount mismatch: a Razorpay order that differs from the snapshot is not honoured", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        const order = razorpay.orders.get(opened.razorpay_order_id)!
        order.amount = 500 * 100
        razorpay.pay(opened.razorpay_order_id, { amount: 500 * 100 })

        const refused = await complete(cartId)
        expect(refused.ok).toBe(false)
        expect(await ordersForCart(cartId)).toHaveLength(0)
      })

      it("webhook retries and duplicate events give one order and never a refund", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id)

        // The browser's verify call and the webhook arrive together.
        const [first, second] = await Promise.all([complete(cartId), complete(cartId)])
        const placed = [first, second].filter((r) => r.ok && r.data.type === "order").map((r) => r.data.order.id)
        expect(placed.length).toBeGreaterThanOrEqual(1)
        for (const r of [first, second]) {
          if (!r.ok) expect(r.status).toBe(409)
        }
        const orderId = placed[0]
        expect(new Set(placed).size).toBe(1)

        // A redelivery later, after the price changed yet again.
        await startSale(1500)
        const redelivered = await complete(cartId)
        expect(redelivered.ok && redelivered.data.order.id).toBe(orderId)
        const again = await complete(cartId)
        expect(again.ok && again.data.order.id).toBe(orderId)

        expect(await ordersForCart(cartId)).toEqual([orderId])
        expect((await orderLines(orderId)).total).toBe(SALE)
        expect(razorpay.refunds).toHaveLength(0)
        expect(await medusaRefunds(orderId)).toHaveLength(0)
      })

      it("a cart that is already paid cannot open a second payment", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        razorpay.pay(opened.razorpay_order_id)

        const second = await openRazorpay(cartId)
        expect(second.ok).toBe(false)
        expect(second.status).toBe(400)
        expect(second.message).toContain("already been paid")

        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
      })

      it("Razorpay unreachable: completion asks to be retried instead of refusing for good", async () => {
        const { cartId, opened } = await paymentOpenedDuringSale()
        await endSale()
        razorpay.pay(opened.razorpay_order_id)

        razorpay.state.down = true
        const later = await complete(cartId)
        expect(later.ok).toBe(false)
        expect(later.status).toBe(500)
        expect(await ordersForCart(cartId)).toHaveLength(0)

        razorpay.state.down = false
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        expect((await orderLines(done.data.order.id)).total).toBe(SALE)
      })

      it("Cash on Delivery always needs today's price", async () => {
        const codSession = async (cartId: string) => {
          const collection = await flow.must(api.post("/store/payment-collections", { cart_id: cartId }, { headers: flow.headers }))
          await flow.must(
            api.post(
              `/store/payment-collections/${collection.payment_collection.id}/payment-sessions`,
              { provider_id: "pp_system_default" },
              { headers: flow.headers }
            )
          )
        }

        await startSale()
        const customer = await flow.customer()
        const cartId = await flow.cart(customer.email, [{ variantId: variant() }])
        await prepare(cartId, customer.email)
        await flow.setMode(cartId, "cod")
        await codSession(cartId)
        await endSale()

        // Straight to completion at the old price: refused, nothing placed.
        const refused = await complete(cartId)
        expect(refused.ok).toBe(false)
        expect(refused.message).toContain("Prices in your cart have changed")
        expect(await ordersForCart(cartId)).toHaveLength(0)

        // Checkout pricing reprices, then the COD order is placed at ₹2,000 plus the COD charge.
        const summary = await flow.setMode(cartId, "cod")
        expect(summary.totals.items_subtotal).toBe(REGULAR)
        await codSession(cartId)
        const done = await complete(cartId)
        expect(done.ok && done.data.type).toBe("order")
        const order = await orderLines(done.data.order.id)
        expect(Number(order.probe.unit_price)).toBe(REGULAR)
        expect(order.total).toBe(REGULAR + 99)
      })
    })
  },
})
