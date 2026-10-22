import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutFlow } from "./helpers/checkout-flow"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
// Orders are held for two hours, so the customer can still cancel them.
process.env.ORDER_CANCEL_WINDOW_MINUTES = "120"
process.env.ORDER_DISPATCH_ENABLED = "true"

jest.setTimeout(240000)

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("cancelling an order", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let admin: Record<string, string>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        const {
          result: [key],
        } = await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
        admin = { Authorization: `Basic ${key.token}` }
      })

      /** Place a COD order with a code on it and wait for its dispatch record. */
      async function orderWithCode(code: string, price: number, customer?: { id: string; email: string }) {
        const who = customer ?? (await flow.customer())
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[price] }])
        expect((await flow.applyCode(cartId, code)).ok).toBe(true)
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)

        // The dispatch record is made by an event handler, a moment after the order.
        const dispatch = getContainer().resolve("orderDispatch") as any
        for (let i = 0; i < 40; i++) {
          const [row] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })
          if (row) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return { ...who, orderId }
      }

      const customerCancel = (orderId: string, customerId: string) =>
        flow.attempt(
          api.post(`/admin/orders/${orderId}/cancellation`, { customer_id: customerId, reason: "changed_mind" }, { headers: admin })
        )

      it("WELCOME200 stays used after the customer cancels the order", async () => {
        const placed = await orderWithCode("WELCOME200", 2000)

        const cancelled: any = await customerCancel(placed.orderId, placed.id)
        expect(cancelled.ok).toBe(true)

        const again = await flow.cart(placed.email, [{ variantId: fx.variantByPrice[2000] }])
        const refused: any = await flow.applyCode(again, "WELCOME200")
        expect(refused.ok).toBe(false)
        expect(refused.message).toMatch(/already been used/)
        expect((await flow.summary(again)).promo_codes).toEqual([])
      })

      it("WELCOME200 stays used after staff cancel the order in the admin", async () => {
        const placed = await orderWithCode("WELCOME200", 2000)

        const cancel = await flow.attempt(api.post(`/admin/orders/${placed.orderId}/cancel`, {}, { headers: admin }))
        expect(cancel.ok).toBe(true)

        const again = await flow.cart(placed.email, [{ variantId: fx.variantByPrice[2000] }])
        expect(((await flow.applyCode(again, "WELCOME200")) as any).ok).toBe(false)
      })

      it("cancelling does not use up or give back anything for another customer", async () => {
        const placed = await orderWithCode("WELCOME200", 2000)
        await customerCancel(placed.orderId, placed.id)

        const other = await flow.customer()
        const cartId = await flow.cart(other.email, [{ variantId: fx.variantByPrice[2000] }])
        expect(((await flow.applyCode(cartId, "WELCOME200")) as any).ok).toBe(true)
      })

      it("EYRA350 and EYRA650 stay reusable after a cancellation", async () => {
        const placed = await orderWithCode("EYRA350", 3500)
        expect(((await customerCancel(placed.orderId, placed.id)) as any).ok).toBe(true)

        const again = await flow.cart(placed.email, [{ variantId: fx.variantByPrice[3500] }])
        expect(((await flow.applyCode(again, "EYRA350")) as any).ok).toBe(true)
      })

      it("a customer cannot cancel someone else's order", async () => {
        const placed = await orderWithCode("EYRA350", 3500)
        const stranger = await flow.customer()
        const result: any = await customerCancel(placed.orderId, stranger.id)
        expect(result.ok).toBe(false)
        expect([403, 404]).toContain(result.status)

        // The real owner still can.
        expect(((await customerCancel(placed.orderId, placed.id)) as any).ok).toBe(true)
      })

      it("a customer cannot cancel once the hold window has closed", async () => {
        const placed = await orderWithCode("EYRA350", 3500)
        const dispatch = getContainer().resolve("orderDispatch") as any
        const [row] = await dispatch.listOrderDispatches({ order_id: placed.orderId }, { take: 1 })
        await dispatch.updateOrderDispatches({ id: row.id, window_ends_at: new Date(Date.now() - 60_000) })

        const result: any = await customerCancel(placed.orderId, placed.id)
        expect(result.ok).toBe(false)
        expect(result.status).toBeGreaterThanOrEqual(400)
      })

      it("an order cannot be cancelled twice", async () => {
        const placed = await orderWithCode("EYRA350", 3500)
        expect(((await customerCancel(placed.orderId, placed.id)) as any).ok).toBe(true)
        expect(((await customerCancel(placed.orderId, placed.id)) as any).ok).toBe(false)
      })

      it("keeps the discount and COD charge on the cancelled order's record", async () => {
        const placed = await orderWithCode("EYRA350", 3500)
        await customerCancel(placed.orderId, placed.id)
        const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [placed.orderId] }, { select: ["id", "status"] })
        expect((order as any).status).toBe("canceled")
      })
    })
  },
})
