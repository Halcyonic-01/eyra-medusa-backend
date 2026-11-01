import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import { emailOrderShipped } from "../../src/modules/order-dispatch/customer-emails"
import { dispatchOrderWorkflow } from "../../src/workflows/dispatch-order"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

const S3_PORT = 18763
const STOREFRONT_PORT = 18764
const SECRET = "integration-shipment-secret"
const HOOK = "integration-shiprocket-hook"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.S3_BUCKET = "eyra-media"
process.env.S3_REGION = "ap-south-1"
process.env.S3_FILE_URL = "https://eyra-media.s3.ap-south-1.amazonaws.com"
process.env.S3_ACCESS_KEY_ID = "AKIAEXAMPLE"
process.env.S3_SECRET_ACCESS_KEY = "example-secret"
process.env.S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`
process.env.S3_FORCE_PATH_STYLE = "true"
process.env.STOREFRONT_REVALIDATE_URL = `http://127.0.0.1:${STOREFRONT_PORT}/api/revalidate`
process.env.STOREFRONT_REVALIDATE_SECRET = "integration-shared-secret"
process.env.STOREFRONT_SHIPMENT_SECRET = SECRET
process.env.SELLER_GSTIN = "20AAJCE7349A1Z1"
process.env.SELLER_STATE = "Jharkhand"
process.env.SHIPROCKET_WEBHOOK_SECRET = HOOK
process.env.REFUND_GATEWAY = "fake"
process.env.ORDER_CANCEL_WINDOW_MINUTES = "120"
process.env.ORDER_DISPATCH_ENABLED = "true"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("shipped email", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let s3: Awaited<ReturnType<typeof startFakeS3>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>

      beforeAll(async () => {
        s3 = await startFakeS3(S3_PORT)
        storefront = await startFakeStorefront(STOREFRONT_PORT, SECRET)
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
      })
      afterAll(async () => {
        await storefront.close()
        await s3.close()
      })
      beforeEach(() => {
        storefront.calls.length = 0
        storefront.behaviour.email = "ok"
      })

      const emails = (type: string) => storefront.callsTo("/api/wallet/notify").filter((call) => call.body.type === type)
      const metadataOf = async (orderId: string) => {
        const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [orderId] }, { select: ["id", "metadata"] })
        return ((order as any).metadata ?? {}) as Record<string, any>
      }

      /** An order placed and waiting to be shipped, not yet marked shipped. */
      async function waitingOrder() {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.reconcile(cartId)
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)
        const dispatch = getContainer().resolve("orderDispatch") as any
        for (let i = 0; i < 40; i++) {
          const [row] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })
          if (row) return { ...who, orderId }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        throw new Error("the order never got a dispatch row")
      }

      describe("when the shipment is created", () => {
        it("goes out once when the shipment is created, with the courier and tracking number", async () => {
          const placed = await waitingOrder()

          const { result, errors } = await dispatchOrderWorkflow(getContainer()).run({
            input: { order_id: placed.orderId, force: true },
            throwOnError: false,
          })
          expect(errors).toHaveLength(0)
          expect((result as any).state).toBe("shipped")

          expect(emails("order_shipped")).toHaveLength(1)
          expect(emails("order_shipped")[0].body).toMatchObject({
            email: placed.email,
            order_id: placed.orderId,
            courier: "Delhivery",
            idempotency_key: `shipped:${placed.orderId}`,
          })
          expect(emails("order_shipped")[0].body.awb).toMatch(/^AWBNEW/)
          expect((await metadataOf(placed.orderId)).email_sent_shipped).toBeTruthy()

          // Asking again, as a retry would, sends nothing more.
          expect(await emailOrderShipped(getContainer(), placed.orderId)).toBe("duplicate")
          expect(emails("order_shipped")).toHaveLength(1)
        })

        it("does not hold up the shipment when the email cannot be sent, and goes out on the next try", async () => {
          const placed = await waitingOrder()
          storefront.behaviour.email = "down"

          const { result, errors } = await dispatchOrderWorkflow(getContainer()).run({
            input: { order_id: placed.orderId, force: true },
            throwOnError: false,
          })
          expect(errors).toHaveLength(0)
          expect((result as any).state).toBe("shipped")
          expect((await metadataOf(placed.orderId)).email_sent_shipped).toBeUndefined()

          storefront.behaviour.email = "ok"
          expect(await emailOrderShipped(getContainer(), placed.orderId)).toBe("sent")
          expect((await metadataOf(placed.orderId)).email_sent_shipped).toBeTruthy()
        })
      })

    })
  },
})
