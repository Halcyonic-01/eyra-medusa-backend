import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow, createCustomersWorkflow, updateCustomersWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"
import { addCapturedRazorpayPayment } from "./helpers/online-payment"
import { shippedOrder } from "./helpers/shipped-order"

const S3_PORT = 18761
const STOREFRONT_PORT = 18762
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
    describe("customer emails", () => {
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

      const send = (body: Record<string, unknown>) =>
        flow.attempt(api.post("/webhooks/shiprocket/order-update", body, { headers: { "x-api-key": HOOK } }))
      const emails = (type: string) => storefront.callsTo("/api/wallet/notify").filter((call) => call.body.type === type)
      const metadataOf = async (orderId: string) => {
        const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [orderId] }, { select: ["id", "metadata"] })
        return ((order as any).metadata ?? {}) as Record<string, any>
      }
      const waitFor = async (check: () => boolean, ms = 10000) => {
        for (let waited = 0; waited < ms && !check(); waited += 200) await new Promise((r) => setTimeout(r, 200))
      }

      describe("delivered", () => {
        it("goes out once, however many times the courier repeats the news", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const ref = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb }

          await send({ ...ref, current_status: "Out For Delivery" })
          expect(emails("order_delivered")).toHaveLength(0)

          await send({ ...ref, current_status: "DELIVERED" })
          await send({ ...ref, current_status: "DELIVERED" })
          await send({ ...ref, current_status: "DELIVERED" })

          expect(emails("order_delivered")).toHaveLength(1)
          expect(emails("order_delivered")[0].body).toMatchObject({
            email: placed.email,
            order_number: placed.displayId,
            idempotency_key: `delivered:${placed.orderId}`,
          })
        })

        it("is sent on a repeat of fresh news when the first try failed, but not on old news", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const ref = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb }
          storefront.behaviour.email = "down"

          expect((await send({ ...ref, current_status: "DELIVERED" })).ok).toBe(true)
          expect((await metadataOf(placed.orderId)).email_sent_delivered).toBeUndefined()

          // A replay from months ago must not email anyone.
          storefront.behaviour.email = "ok"
          storefront.calls.length = 0
          await send({ ...ref, current_status: "DELIVERED", current_timestamp: "2026-01-05 10:00:00" })
          expect(emails("order_delivered")).toHaveLength(0)

          await send({ ...ref, current_status: "DELIVERED" })
          expect(emails("order_delivered")).toHaveLength(1)
          expect((await metadataOf(placed.orderId)).email_sent_delivered).toBeTruthy()
        })

        it("is not sent for a parcel that came back, and the webhook still answers 200 when email is down", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          storefront.behaviour.email = "down"
          const back = await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })
          expect(back.ok).toBe(true)
          expect(emails("order_delivered")).toHaveLength(0)
        })
      })

      describe("refund after a parcel is returned", () => {
        it("tells the customer the online refund is on its way, once", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await addCapturedRazorpayPayment(getContainer(), placed.orderId, 2000)
          const ref = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" }

          await send(ref)
          await send(ref)

          expect(emails("refund_processed")).toHaveLength(1)
          expect(emails("refund_processed")[0].body).toMatchObject({
            email: placed.email,
            order_number: placed.displayId,
            refund_amount: 1901,
            idempotency_key: `rto_refund:${placed.orderId}`,
          })
          expect(emails("refund_processed")[0].body.credit_note).toMatch(/^CN\//)
        })

        it("sends no refund email when nothing was paid online", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })
          expect(emails("refund_processed")).toHaveLength(0)
        })
      })

      describe("welcome offer", () => {
        const create = (email: string, metadata?: Record<string, unknown>) =>
          createCustomersWorkflow(getContainer()).run({ input: { customersData: [{ email, metadata }] } })

        it("goes to someone who signed up for updates, once", async () => {
          await create("subscriber@example.com", { newsletter_subscriber: true })
          await waitFor(() => emails("welcome_offer").length > 0)

          expect(emails("welcome_offer")).toHaveLength(1)
          expect(emails("welcome_offer")[0].body).toMatchObject({
            email: "subscriber@example.com",
            code: "WELCOME200",
            amount: 200,
            min_order: 1499,
          })
        })

        const tag = (customerId: string) =>
          updateCustomersWorkflow(getContainer()).run({
            input: { selector: { id: customerId }, update: { metadata: { newsletter_subscriber: true } } },
          })

        it("goes to an existing customer with no orders when the signup tags them, and only once", async () => {
          const existing = await flow.customer()
          await tag(existing.id)
          await waitFor(() => emails("welcome_offer").some((c) => c.body.email === existing.email))

          expect(emails("welcome_offer").filter((c) => c.body.email === existing.email)).toHaveLength(1)

          // More updates, such as a later campaign marker, send nothing more.
          await tag(existing.id)
          await new Promise((resolve) => setTimeout(resolve, 2000))
          expect(emails("welcome_offer").filter((c) => c.body.email === existing.email)).toHaveLength(1)
        })

        it("is not sent to an existing customer who has already ordered, though they are now on the list", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await tag(placed.id)
          await new Promise((resolve) => setTimeout(resolve, 2500))

          expect(emails("welcome_offer").filter((c) => c.body.email === placed.email)).toHaveLength(0)
          const [customer] = await getContainer().resolve(Modules.CUSTOMER).listCustomers({ id: [placed.id] })
          expect((customer as any).metadata.newsletter_subscriber).toBe(true)
        })

        it("is not sent to someone who only made an account", async () => {
          await create("plain-account@example.com")
          // Give the handler time to have acted, if it were going to.
          await new Promise((resolve) => setTimeout(resolve, 2000))
          expect(emails("welcome_offer").filter((c) => c.body.email === "plain-account@example.com")).toHaveLength(0)
        })
      })
    })
  },
})
