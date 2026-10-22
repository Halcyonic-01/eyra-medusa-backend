import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import generateInvoicePdfsJob from "../../src/jobs/generate-invoice-pdfs"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"
import { startFakeS3, startFakeStorefront } from "./helpers/fake-servers"

// Fixed local ports for the stand-ins. They are set in the environment before
// Medusa starts, so its own S3 provider and storefront calls reach them.
const S3_PORT = 18731
const STOREFRONT_PORT = 18732
const SECRET = "integration-shipment-secret"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.S3_BUCKET = "eyra-media"
process.env.S3_REGION = "ap-south-1"
process.env.S3_FILE_URL = "https://eyra-media.s3.ap-south-1.amazonaws.com"
process.env.S3_ACCESS_KEY_ID = "AKIAEXAMPLE"
process.env.S3_SECRET_ACCESS_KEY = "example-secret"
process.env.S3_PREFIX = "eyra"
process.env.S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`
process.env.S3_FORCE_PATH_STYLE = "true"
process.env.STOREFRONT_REVALIDATE_URL = `http://127.0.0.1:${STOREFRONT_PORT}/api/revalidate`
process.env.STOREFRONT_REVALIDATE_SECRET = "integration-shared-secret"
process.env.STOREFRONT_SHIPMENT_SECRET = SECRET
// Nothing here should start a real shipment.
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(240000)

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("invoice PDFs", () => {
      let fx: LaunchFixtures
      let headers: Record<string, string>
      let admin: Record<string, string>
      let s3: Awaited<ReturnType<typeof startFakeS3>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>
      const numbers = new Map<string, string>()
      let seq = 0

      beforeAll(async () => {
        s3 = await startFakeS3(S3_PORT)
        storefront = await startFakeStorefront(STOREFRONT_PORT, SECRET, numbers)
        fx = await seedLaunchFixtures(getContainer())
        headers = { "x-publishable-api-key": fx.publishableKey }

        const {
          result: [key],
        } = await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
        admin = { Authorization: `Basic ${key.token}` }
      })

      afterAll(async () => {
        await storefront.close()
        await s3.close()
      })

      beforeEach(() => {
        storefront.calls.length = 0
        storefront.behaviour.mode = "ok"
        storefront.behaviour.numberOverride = undefined
      })

      const getPdf = async (orderId: string, query = "", auth = admin) => {
        try {
          const res = await api.get(`/admin/orders/${orderId}/invoice${query}`, {
            headers: auth,
            responseType: "arraybuffer",
          })
          return { status: res.status, headers: res.headers, body: Buffer.from(res.data) }
        } catch (error: any) {
          const raw = error.response?.data
          let json: any = null
          try {
            json = JSON.parse(Buffer.from(raw ?? "").toString() || "null")
          } catch {
            json = null
          }
          return { status: error.response?.status as number, headers: error.response?.headers ?? {}, body: json }
        }
      }

      /** A real order from the checkout flow, with the invoice number a shipped order carries. */
      async function shippedOrder(withNumber = true): Promise<{ id: string; number: string | null }> {
        const email = `invoice${++seq}@example.com`
        await getContainer().resolve(Modules.CUSTOMER).createCustomers({ email, has_account: true })

        const cart: any = (await api.post("/store/carts", { region_id: fx.regionId, sales_channel_id: fx.salesChannelId, email }, { headers })).data
        const cartId = cart.cart.id
        await api.post(`/store/carts/${cartId}/line-items`, { variant_id: fx.variantByPrice[2000], quantity: 1 }, { headers })
        await api.post(`/store/carts/${cartId}/payment-mode`, { mode: "cod" }, { headers })
        await api.post(
          `/store/carts/${cartId}`,
          {
            email,
            shipping_address: {
              first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
              city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
            },
          },
          { headers }
        )
        const collection: any = (await api.post("/store/payment-collections", { cart_id: cartId }, { headers })).data
        await api.post(
          `/store/payment-collections/${collection.payment_collection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          { headers }
        )
        const done: any = (await api.post(`/store/carts/${cartId}/complete`, {}, { headers })).data
        const orderId = done.order.id as string

        const number = withNumber ? `EYRA/26-27/${String(1000 + seq).padStart(5, "0")}` : null
        if (number) {
          numbers.set(orderId, number)
          await getContainer().resolve(Modules.ORDER).updateOrders(
            { id: orderId },
            { metadata: { invoice_number: number, invoice_date: "2026-10-18", dispatch_state: "shipped" } }
          )
        }
        return { id: orderId, number }
      }

      const metadataOf = async (orderId: string) => {
        const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [orderId] }, { select: ["id", "metadata"] })
        return ((order as any).metadata ?? {}) as Record<string, any>
      }

      it("is behind the admin sign-in", async () => {
        const { id } = await shippedOrder()
        const response = await getPdf(id, "", {})
        expect(response.status).toBe(401)
        expect(storefront.calls).toHaveLength(0)
      })

      it("says an order that has not shipped has no tax invoice", async () => {
        const { id } = await shippedOrder(false)
        const response = await getPdf(id)
        expect(response.status).toBe(409)
        expect(response.body.code).toBe("no_invoice")
        expect(storefront.calls).toHaveLength(0)
      })

      it("draws the PDF once, keeps it in S3 as a private file, and records it on the order", async () => {
        const { id, number } = await shippedOrder()
        const first = await getPdf(id)

        expect(first.status).toBe(200)
        expect(first.headers["content-type"]).toBe("application/pdf")
        expect(first.headers["cache-control"]).toBe("private, no-store")
        expect(first.headers["x-invoice-stored"]).toBe("true")
        expect(first.body.subarray(0, 5).toString()).toBe("%PDF-")
        expect(first.body.toString()).toContain(number!)
        expect(storefront.calls).toHaveLength(1)

        const meta = await metadataOf(id)
        expect(meta.invoice_number).toBe(number)
        expect(meta.invoice_pdf.invoice_number).toBe(number)
        expect(meta.invoice_pdf.key).toMatch(/^eyra\//)
        expect(meta.invoice_pdf.sha256).toMatch(/^[0-9a-f]{64}$/)

        const object = [...s3.objects.entries()].find(([path]) => path.endsWith(meta.invoice_pdf.key))
        expect(object).toBeTruthy()
        expect(object![1].headers["x-amz-acl"]).toBe("private")
        expect(object![1].headers["content-type"]).toBe("application/pdf")
        expect(object![1].body.equals(first.body)).toBe(true)

        // Asking again serves the stored file and draws nothing new.
        const second = await getPdf(id)
        expect(second.status).toBe(200)
        expect(second.body.equals(first.body)).toBe(true)
        expect(storefront.calls).toHaveLength(1)
        expect((await metadataOf(id)).invoice_pdf.key).toBe(meta.invoice_pdf.key)
      })

      it("draws one PDF even when two people ask at the same moment", async () => {
        const { id } = await shippedOrder()
        const [a, b] = await Promise.all([getPdf(id), getPdf(id)])
        expect(a.status).toBe(200)
        expect(b.status).toBe(200)
        expect(a.body.equals(b.body)).toBe(true)
        expect(storefront.calls).toHaveLength(1)
      })

      it("keeps the same invoice number through retries after a failure", async () => {
        const { id, number } = await shippedOrder()

        storefront.behaviour.mode = "down"
        const failed = await getPdf(id)
        expect(failed.status).toBe(503)
        let meta = await metadataOf(id)
        expect(meta.invoice_number).toBe(number)
        expect(meta.invoice_pdf).toBeUndefined()
        expect(meta.invoice_pdf_attempts).toBe(1)
        expect(meta.invoice_pdf_retry_at).toBeTruthy()

        // The job waits out the back-off before it tries again.
        storefront.calls.length = 0
        await generateInvoicePdfsJob(getContainer())
        expect(storefront.calls.filter((call) => call.order_id === id)).toHaveLength(0)

        storefront.behaviour.mode = "ok"
        await getContainer().resolve(Modules.ORDER).updateOrders({ id }, { metadata: { invoice_pdf_retry_at: null } })
        await generateInvoicePdfsJob(getContainer())
        meta = await metadataOf(id)
        expect(meta.invoice_number).toBe(number)
        expect(meta.invoice_pdf.invoice_number).toBe(number)
        expect(meta.invoice_pdf_attempts).toBe(0)
      })

      it("does not hold the number hostage: a wrong number from the storefront is refused", async () => {
        const { id } = await shippedOrder()
        storefront.behaviour.numberOverride = "EYRA/26-27/99999"
        const response = await getPdf(id)
        expect(response.status).toBe(503)
        const meta = await metadataOf(id)
        expect(meta.invoice_pdf).toBeUndefined()
      })

      it("does not keep an invoice that is not valid, and shows it to staff only as a marked draft", async () => {
        const { id } = await shippedOrder()
        storefront.behaviour.mode = "gstin_missing"

        const refused = await getPdf(id)
        expect(refused.status).toBe(422)
        expect(refused.body.code).toBe("invoice_not_valid")
        expect(refused.body.message).toMatch(/GSTIN/)
        expect((await metadataOf(id)).invoice_pdf).toBeUndefined()

        const draft = await getPdf(id, "?draft=1")
        expect(draft.status).toBe(200)
        expect(draft.headers["x-invoice-stored"]).toBe("false")
        expect((await metadataOf(id)).invoice_pdf).toBeUndefined()
        expect([...s3.objects.keys()].some((path) => path.includes(id))).toBe(false)
      })

      it("never replaces a stored invoice with another", async () => {
        const { id, number } = await shippedOrder()
        const first = await getPdf(id)
        const key = (await metadataOf(id)).invoice_pdf.key

        // A different PDF would be drawn if it were asked for again.
        storefront.behaviour.numberOverride = "EYRA/26-27/88888"
        const again = await getPdf(id)
        expect(again.body.equals(first.body)).toBe(true)
        expect(again.body.toString()).toContain(number!)

        await generateInvoicePdfsJob(getContainer())
        expect((await metadataOf(id)).invoice_pdf.key).toBe(key)
      })

      it("the job stores PDFs for shipped orders that have none", async () => {
        const { id, number } = await shippedOrder()
        storefront.calls.length = 0
        await generateInvoicePdfsJob(getContainer())
        const meta = await metadataOf(id)
        expect(meta.invoice_pdf.invoice_number).toBe(number)
        expect(storefront.calls.filter((call) => call.order_id === id)).toHaveLength(1)
      })

      it("does nothing for an order that has not shipped", async () => {
        const { id } = await shippedOrder(false)
        storefront.calls.length = 0
        await generateInvoicePdfsJob(getContainer())
        expect(storefront.calls.filter((call) => call.order_id === id)).toHaveLength(0)
        expect((await metadataOf(id)).invoice_pdf).toBeUndefined()
      })
    })
  },
})
