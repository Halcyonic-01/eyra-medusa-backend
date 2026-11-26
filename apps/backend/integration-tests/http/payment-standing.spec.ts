import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils"
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  updateInventoryLevelsWorkflow,
  updateRegionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { reconcileCurrentAttempts } from "../../src/modules/payment-snapshot/current-attempts"
import { verifyLateRefunds } from "../../src/modules/payment-snapshot/refund-verification"
import { checkoutFlow } from "./helpers/checkout-flow"
import { FAKE_PAYU_KEY, FAKE_PAYU_SALT, startFakePayu } from "./helpers/fake-payu"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

const PAYU_PORT = 19461
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
process.env.PAYMENT_STATUS_CACHE_MS = "0"

jest.setTimeout(300000)

// Phase 6: what the storefront is told about a cart's payment, and that a
// payment still in progress is never paid for twice.

const PAYU = "pp_payu_payu"
const RAZORPAY = "pp_razorpay_razorpay"

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("Cart payment status and the pending hold", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let payu: Awaited<ReturnType<typeof startFakePayu>>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19462)
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
        payu.state.down = false
      })

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
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
      const standing = async (cartId: string) => (await flow.must(api.get(`/store/carts/${cartId}/payment-status`, { headers: flow.headers }))).payment
      const openRazorpay = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
      const openPayu = (cartId: string) => flow.attempt(api.post(`/store/carts/${cartId}/payu-session`, {}, { headers: flow.headers }))
      /** As if the payment had started `minutes` ago. */
      const startedAgo = (cartId: string, minutes: number) =>
        pg().raw(`UPDATE payment_price_snapshot SET created_at = now() - (? * interval '1 minute') WHERE cart_id = ?`, [minutes, cartId])

      it("a fresh cart: nothing paid, any provider may be used", async () => {
        const cartId = await preparedCart()
        expect(await standing(cartId)).toMatchObject({ state: "none", can_pay: true, allowed_providers: "any", refunds: [] })
      })

      it("an unknown cart is a 404, not a guess", async () => {
        const res = await flow.attempt(api.get(`/store/carts/cart_does_not_exist/payment-status`, { headers: flow.headers }))
        expect(res.ok).toBe(false)
        expect(res.status).toBe(404)
      })

      it("PayU pending: no new payment at all for the hold, then a retry with PayU only, never a switch", async () => {
        const cartId = await preparedCart()
        const opened = await openPayu(cartId)
        expect(opened.ok).toBe(true)
        const txnid = opened.ok ? (opened.data.txnid as string) : ""
        payu.pay(txnid, "2000.00", "pending")

        expect(await standing(cartId)).toMatchObject({ state: "pending", provider_name: "PayU", can_pay: false, allowed_providers: [] })
        const again = await openPayu(cartId)
        expect(again.ok).toBe(false)
        expect(again.message).toMatch(/Please don't pay again/)
        expect((await openRazorpay(cartId)).ok).toBe(false)

        await startedAgo(cartId, 31)
        const later = await standing(cartId)
        expect(later).toMatchObject({ state: "pending", can_pay: true, allowed_providers: [PAYU] })
        expect(new Date(later.retry_after).getTime()).toBeLessThan(Date.now())
        const switched = await openRazorpay(cartId)
        expect(switched.ok).toBe(false)
        expect(switched.message).toMatch(/wait for it before paying another way/)
        expect((await openPayu(cartId)).ok).toBe(true)
      })

      it("a Razorpay try stuck in 'created' continues the same Razorpay order, never a second one, and blocks switching", async () => {
        const cartId = await preparedCart()
        const opened = await openRazorpay(cartId)
        const order = opened.ok ? (opened.data.razorpay_order_id as string) : ""
        // What Razorpay keeps after a failed or abandoned netbanking or UPI try.
        razorpay.payments.set(order, [{ id: "pay_PENDING1", entity: "payment", order_id: order, amount: 200000, currency: "INR", status: "created" as never }])

        expect(await standing(cartId)).toMatchObject({ state: "pending", provider_name: "Razorpay", resume: true, can_pay: true, allowed_providers: [RAZORPAY] })
        const retry = await openRazorpay(cartId)
        expect(retry.ok && retry.data).toMatchObject({ razorpay_order_id: order, resumed: true })
        expect((await pg().raw(`SELECT count(*)::int AS n FROM payment_price_snapshot WHERE cart_id = ?`, [cartId])).rows[0].n).toBe(1)
        const switched = await openPayu(cartId)
        expect(switched.ok).toBe(false)
        expect(switched.message).toMatch(/still being confirmed/)
      })

      it("no resume once the cart changed: the stuck try then holds every new payment", async () => {
        const cartId = await preparedCart()
        const opened = await openRazorpay(cartId)
        const order = opened.ok ? (opened.data.razorpay_order_id as string) : ""
        razorpay.payments.set(order, [{ id: "pay_PENDING2", entity: "payment", order_id: order, amount: 200000, currency: "INR", status: "created" as never }])
        await flow.must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: fx.variantByPrice[2000], quantity: 1 }, { headers: flow.headers }))

        expect(await standing(cartId)).toMatchObject({ state: "pending", resume: false, can_pay: false })
        const retry = await openRazorpay(cartId)
        expect(retry.ok).toBe(false)
        expect(retry.message).toMatch(/still being confirmed/)
      })

      it("paid but not yet an order: told so, and no second payment can be opened", async () => {
        const cartId = await preparedCart()
        const opened = await openRazorpay(cartId)
        razorpay.pay(opened.ok ? (opened.data.razorpay_order_id as string) : "")
        expect(await standing(cartId)).toMatchObject({ state: "paid", provider_name: "Razorpay", can_pay: false })
        expect((await openPayu(cartId)).ok).toBe(false)
      })

      it("an order: reported with its id, no payment allowed", async () => {
        const cartId = await preparedCart()
        const opened = await openRazorpay(cartId)
        razorpay.pay(opened.ok ? (opened.data.razorpay_order_id as string) : "")
        const done = await flow.must(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
        expect(await standing(cartId)).toMatchObject({ state: "ordered", order_id: done.order.id, can_pay: false })
      })

      it("a provider that cannot be asked: unknown, and paying is not allowed", async () => {
        const cartId = await preparedCart()
        expect((await openRazorpay(cartId)).ok).toBe(true)
        razorpay.state.down = true
        expect(await standing(cartId)).toMatchObject({ state: "unknown", can_pay: false })
        expect((await openPayu(cartId)).ok).toBe(false)
      })

      it("Cash on Delivery cannot complete while an online payment is still pending, even calling the store API directly", async () => {
        const cartId = await preparedCart()
        const opened = await openPayu(cartId)
        const txnid = opened.ok ? (opened.data.txnid as string) : ""
        payu.pay(txnid, "2000.00", "pending")

        // Straight to Medusa's public routes: switch the cart to Cash on Delivery and complete it.
        await flow.setMode(cartId, "cod")
        const collection = await flow.must(api.post("/store/payment-collections", { cart_id: cartId }, { headers: flow.headers }))
        await flow.must(
          api.post(`/store/payment-collections/${collection.payment_collection.id}/payment-sessions`, { provider_id: "pp_system_default" }, { headers: flow.headers })
        )
        const refused = await flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
        expect(refused.ok).toBe(false)
        expect(refused.message).toMatch(/PayU is still being confirmed/)

        // PayU down: still refused, never guessed.
        payu.state.down = true
        expect((await flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))).message).toMatch(/couldn't check/)
        payu.state.down = false

        // PayU says it failed: nothing was taken, so Cash on Delivery goes ahead.
        payu.pay(txnid, "2000.00", "failure")
        const placed = await flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
        expect(placed.ok && placed.data.type).toBe("order")
      })

      it("a refund shows as refunded, then as paid out once the provider pays it", async () => {
        const { data: profiles } = await query().graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query().graph({ entity: "stock_location", fields: ["id"] })
        const sku = `STAND-${Date.now()}`
        const { result: [product] } = await createProductsWorkflow(container()).run({
          input: {
            products: [{
              title: "Standing probe", handle: `standing-probe-${Date.now()}`, status: ProductStatus.PUBLISHED,
              shipping_profile_id: (profiles[0] as any).id, sales_channels: [{ id: fx.salesChannelId }],
              options: [{ title: "Size", values: ["One"] }],
              variants: [{ title: "One", sku, manage_inventory: true, options: { Size: "One" }, prices: [{ amount: 2000, currency_code: "inr" }] }],
            }],
          } as never,
        })
        const { data: items } = await query().graph({ entity: "inventory_item", fields: ["id"], filters: { sku } })
        const level = { inventory_item_id: (items[0] as any).id, location_id: (locations[0] as any).id }
        await createInventoryLevelsWorkflow(container()).run({ input: { inventory_levels: [{ ...level, stocked_quantity: 1 }] } })

        const cartId = await preparedCart((product as any).variants[0].id)
        const opened = await openRazorpay(cartId)
        razorpay.pay(opened.ok ? (opened.data.razorpay_order_id as string) : "")
        await updateInventoryLevelsWorkflow(container()).run({ input: { updates: [{ ...level, stocked_quantity: 0 }] } })
        await startedAgo(cartId, 10)
        await reconcileCurrentAttempts(container(), { providers: [RAZORPAY] })

        expect(await standing(cartId)).toMatchObject({
          state: "none",
          can_pay: true,
          refunds: [{ provider_name: "Razorpay", amount: 2000, status: "refunded" }],
        })
        await verifyLateRefunds(container())
        expect((await standing(cartId)).refunds).toEqual([expect.objectContaining({ status: "paid_out" })])
      })
    })
  },
})
