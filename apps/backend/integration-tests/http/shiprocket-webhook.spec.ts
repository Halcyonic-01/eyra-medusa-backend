import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"
import { addCapturedRazorpayPayment } from "./helpers/online-payment"
import { shippedOrder } from "./helpers/shipped-order"

const S3_PORT = 18751
const STOREFRONT_PORT = 18752
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
    describe("Shiprocket tracking updates", () => {
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
      })

      const send = (body: Record<string, unknown>, key: string | null = HOOK) =>
        flow.attempt(api.post("/webhooks/shiprocket/order-update", body, { headers: key ? { "x-api-key": key } : {} }))
      const dispatchOf = async (orderId: string) => {
        const [row] = await (getContainer().resolve("orderDispatch") as any).listOrderDispatches({ order_id: orderId }, { take: 1 })
        return row
      }
      const metadataOf = async (orderId: string) => {
        const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [orderId] }, { select: ["id", "metadata"] })
        return ((order as any).metadata ?? {}) as Record<string, any>
      }
      const notes = async (orderId: string) =>
        (await (getContainer().resolve("creditNote") as any).listCreditNotes({ order_id: orderId })) as any[]

      it("refuses an update without the secret, or with the wrong one", async () => {
        const placed = await shippedOrder(getContainer(), flow, fx)
        const body = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "DELIVERED" }
        expect((await send(body, null)).ok).toBe(false)
        const wrong = await send(body, "nope")
        expect(wrong.ok).toBe(false)
        expect((wrong as any).status).toBe(401)
        expect((await dispatchOf(placed.orderId)).delivered_at).toBeNull()
      })

      it("acknowledges a reference it does not know, and a payload with no status, without acting", async () => {
        const unknown: any = await send({ order_id: "EYRA-99999", awb: "NOPE", current_status: "DELIVERED" })
        expect(unknown.ok).toBe(true)
        expect(unknown.data.acted).toBe(false)
        const empty: any = await send({ order_id: "EYRA-1" })
        expect(empty.ok).toBe(true)
        expect(empty.data.reason).toBe("missing_fields")
      })

      it("records an attempt and a delivery once, and keeps the order's other metadata", async () => {
        const placed = await shippedOrder(getContainer(), flow, fx)
        await getContainer().resolve(Modules.ORDER).updateOrders({ id: placed.orderId }, { metadata: { keep_me: "yes" } })
        const ref = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb }

        const out: any = await send({ ...ref, current_status: "Out For Delivery" })
        expect(out.data).toMatchObject({ acted: true, matched: "forward" })
        let row = await dispatchOf(placed.orderId)
        expect(row.delivery_attempted_at).toBeTruthy()
        expect(row.delivered_at).toBeNull()
        expect(row.shiprocket_status).toBe("OUT FOR DELIVERY")

        await send({ ...ref, current_status: "DELIVERED", current_timestamp: "2026-10-20 14:30:00" })
        row = await dispatchOf(placed.orderId)
        const deliveredAt = new Date(row.delivered_at)
        expect(deliveredAt.toISOString()).toBe("2026-10-20T09:00:00.000Z")

        // A repeat of the same news changes nothing.
        await send({ ...ref, current_status: "DELIVERED", current_timestamp: "2026-10-21 09:00:00" })
        expect(new Date((await dispatchOf(placed.orderId)).delivered_at).toISOString()).toBe(deliveredAt.toISOString())

        const metadata = await metadataOf(placed.orderId)
        expect(metadata.shiprocket_status).toBe("DELIVERED")
        expect(metadata.keep_me).toBe("yes")
        expect(metadata.invoice_number ?? placed.invoiceNumber).toBeTruthy()
        expect(await notes(placed.orderId)).toHaveLength(0)
      })

      it("finds the shipment by its AWB when the reference is missing", async () => {
        const placed = await shippedOrder(getContainer(), flow, fx)
        const result: any = await send({ awb_code: placed.awb, shipment_status: "DELIVERED" })
        expect(result.data.acted).toBe(true)
        expect((await dispatchOf(placed.orderId)).delivered_at).toBeTruthy()
      })

      describe("a parcel returned to us", () => {
        it("on a Cash on Delivery order gets a credit note, keeps the COD charge and the 99 fee, and refunds nothing", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const ref = { order_id: `EYRA-${placed.displayId}`, awb: placed.awb }

          await send({ ...ref, current_status: "Undelivered" })
          await send({ ...ref, current_status: "RTO INITIATED" })
          expect((await dispatchOf(placed.orderId)).rto_initiated_at).toBeTruthy()
          expect(await notes(placed.orderId)).toHaveLength(0)

          const back: any = await send({ ...ref, current_status: "RTO DELIVERED" })
          expect(back.ok).toBe(true)
          const [note] = await notes(placed.orderId)
          expect(note.kind).toBe("rto")
          // The courier tried, so the COD charge stays: the note covers the 2,000 of jewellery only.
          expect(note.payload.line_items.map((l: any) => l.hsn_sac)).toEqual(["7113"])
          expect(note.payload.totals.total).toBe(2000)
          expect(note.payload.adjustments).toMatchObject({ reverse_logistics_fee_deduction: 99, net_refund_amount: 0, credit_method: "none" })
          expect(note.payload.adjustments.fee).toMatchObject({ type: "reverse_logistics", amount: 99, taxable_value: 83.9, igst: 15.1 })

          const result = (await metadataOf(placed.orderId)).rto_refund
          expect(result.status).toBe("nothing_to_refund")
          expect(result.credit_note_number).toBe(note.credit_note_number)

          // The same news again changes nothing.
          await send({ ...ref, current_status: "RTO DELIVERED" })
          expect(await notes(placed.orderId)).toHaveLength(1)
          expect(storefront.callsTo("/api/ops/notify").some((c) => c.body.type === "rto_received")).toBe(true)
        })

        it("refunds what was paid online, less the 99 fee, to the payment it came from", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await addCapturedRazorpayPayment(getContainer(), placed.orderId, 2000)

          await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })

          const result = (await metadataOf(placed.orderId)).rto_refund
          expect(result).toMatchObject({ status: "refunded", refund_online: 1901, refund_wallet: 0 })
          expect(result.razorpay_refund_id).toMatch(/^rfnd_FAKE_rto-crn_/)
        })

        it("tells a person when an online payment was never recorded as captured, instead of refunding nothing", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await addCapturedRazorpayPayment(getContainer(), placed.orderId, 2000, { captured: false })

          await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })

          const result = (await metadataOf(placed.orderId)).rto_refund
          expect(result.status).toBe("needs_attention")
          expect(result.error).toMatch(/not recorded as captured/)
          expect(result.refund_online).toBe(1901)
          // The credit note is still made, and says money goes back, since the customer did pay.
          const [note] = await notes(placed.orderId)
          expect(note.payload.adjustments).toMatchObject({ credit_method: "refund", net_refund_amount: 1901 })
        })

        it("leaves the money for a person when automatic refunds are switched off", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await addCapturedRazorpayPayment(getContainer(), placed.orderId, 2000)
          process.env.RTO_AUTO_REFUND = "false"
          try {
            await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })
          } finally {
            delete process.env.RTO_AUTO_REFUND
          }
          const result = (await metadataOf(placed.orderId)).rto_refund
          expect(result.status).toBe("needs_attention")
          expect(result.error).toMatch(/RTO_AUTO_REFUND/)
          expect(await notes(placed.orderId)).toHaveLength(1)
        })

        it("returns wallet credit the order used to the wallet", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await getContainer().resolve(Modules.ORDER).createOrderCreditLines([
            { order_id: placed.orderId, amount: 500, reference: "wallet", reference_id: "wallet_test" } as any,
          ])
          await send({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })

          const result = (await metadataOf(placed.orderId)).rto_refund
          expect(result).toMatchObject({ status: "refunded", refund_online: 0, refund_wallet: 500 })
          const wallet = getContainer().resolve("wallet") as any
          const [row] = await wallet.listWalletTransactions({ order_id: placed.orderId })
          expect(row).toMatchObject({ type: "issued", reason: "return" })
          expect(Number(row.amount)).toBe(500)
          // Twelve months, not the wallet's usual six.
          const months = (new Date(row.expires_at).getTime() - Date.now()) / (30 * 24 * 3600 * 1000)
          expect(months).toBeGreaterThan(11.5)
        })
      })
    })
  },
})
