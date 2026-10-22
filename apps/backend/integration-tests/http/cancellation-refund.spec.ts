import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutFlow } from "./helpers/checkout-flow"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"
import { addCapturedRazorpayPayment } from "./helpers/online-payment"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.REFUND_GATEWAY = "fake"
// Even if an old setting is still around, an unshipped order is refunded in full.
process.env.ORDER_CANCEL_FEE = "100"
process.env.ORDER_CANCEL_WINDOW_MINUTES = "120"
process.env.ORDER_DISPATCH_ENABLED = "true"

jest.setTimeout(300000)

// An order cancelled before it ships is refunded in full, with nothing kept, to the
// payment method it was paid with. There is no wallet option and no cancellation fee.

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("cancelling before dispatch", () => {
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

      async function heldOrder(paidOnline = 0) {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)
        if (paidOnline > 0) await addCapturedRazorpayPayment(getContainer(), orderId, paidOnline)
        const dispatch = getContainer().resolve("orderDispatch") as any
        for (let i = 0; i < 40; i++) {
          const [row] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })
          if (row) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return { ...who, orderId }
      }
      const preview = async (placed: { orderId: string; id: string }) =>
        ((await api.get(`/admin/orders/${placed.orderId}/cancellation?customer_id=${placed.id}`, { headers: admin })).data as any).preview
      const cancel = (placed: { orderId: string; id: string }, extra: Record<string, unknown> = {}) =>
        flow.attempt(api.post(`/admin/orders/${placed.orderId}/cancellation`, { customer_id: placed.id, reason: "changed_mind", ...extra }, { headers: admin }))

      it("offers one refund, in full, to the original payment: no fee, no wallet choice", async () => {
        const placed = await heldOrder(2000)
        const shown = await preview(placed)
        expect(shown.can_cancel).toBe(true)
        expect(shown.fee).toBe(0)
        expect(shown.requires_choice).toBe(false)
        expect(shown.options.wallet).toBeNull()
        expect(shown.options.original).toMatchObject({ amount: 2000, fee: 0, available: true })
      })

      it("refunds everything paid online to the original payment method and keeps nothing", async () => {
        const placed = await heldOrder(2000)
        const result: any = await cancel(placed)
        expect(result.ok).toBe(true)
        expect(result.data.cancellation).toMatchObject({
          refund_method: "original",
          paid_online: 2000,
          fee: 0,
          refund_amount: 2000,
          refund_status: "initiated",
          status: "completed",
        })
        expect(result.data.cancellation.refund_error).toBeNull()
      })

      it("is not changed by an old cancellation fee setting", async () => {
        const placed = await heldOrder(1000)
        const result: any = await cancel(placed)
        expect(result.data.cancellation).toMatchObject({ refund_amount: 1000, fee: 0 })
      })

      it("refuses a request to be refunded to the wallet instead, and cancels nothing", async () => {
        const placed = await heldOrder(2000)
        const refused: any = await cancel(placed, { refund_method: "wallet" })
        expect(refused.ok).toBe(false)
        expect(refused.message).toMatch(/payment method the order was paid with/)
        expect((await preview(placed)).can_cancel).toBe(true)
        // It can still be cancelled the normal way.
        expect(((await cancel(placed)) as any).ok).toBe(true)
      })

      it("an order nothing was paid online for just cancels, with nothing to refund", async () => {
        const placed = await heldOrder(0)
        const shown = await preview(placed)
        expect(shown.options.original).toBeNull()
        const result: any = await cancel(placed)
        expect(result.ok).toBe(true)
        expect(result.data.cancellation).toMatchObject({ refund_method: "none", refund_amount: 0, refund_status: "not_needed" })
      })

      it("says what to do once the parcel has shipped: refuse delivery, or return within 7 days", async () => {
        const placed = await heldOrder(0)
        const dispatch = getContainer().resolve("orderDispatch") as any
        const [row] = await dispatch.listOrderDispatches({ order_id: placed.orderId }, { take: 1 })
        await dispatch.updateOrderDispatches({ id: row.id, state: "shipped", shipped_at: new Date() })

        const shown = await preview(placed)
        expect(shown.can_cancel).toBe(false)
        expect(shown.code).toBe("shipment_created")
        expect(shown.message).toMatch(/refuse delivery/)
        expect(shown.message).toMatch(/₹99/)
        expect(shown.message).toMatch(/7 days/)
        expect(((await cancel(placed)) as any).ok).toBe(false)
      })
    })
  },
})
