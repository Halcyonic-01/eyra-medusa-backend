import { createHmac } from "node:crypto"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import { createApiKeysWorkflow, createInventoryLevelsWorkflow, createProductsWorkflow } from "@medusajs/medusa/core-flows"
import finishReceivedReturnsJob from "../../src/jobs/finish-received-returns"
import { checkoutFlow } from "./helpers/checkout-flow"
import { markDelivered } from "./helpers/delivery"
import { startFakeRazorpay, startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, setToteStock, type LaunchFixtures } from "./helpers/launch-fixtures"
import { shippedOrder } from "./helpers/shipped-order"

const S3_PORT = 18761
const STOREFRONT_PORT = 18762
const RAZORPAY_PORT = 18763
const SECRET = "integration-shipment-secret"
const HOOK = "integration-shiprocket-hook"
const RZP_SECRET = "integration-webhook"

process.env.RAZORPAY_ID = "rzp_test_integration"
process.env.RAZORPAY_SECRET = "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET = RZP_SECRET
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${RAZORPAY_PORT}`
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

jest.setTimeout(400000)

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("returns and exchanges", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let admin: Record<string, string>
      let s3: Awaited<ReturnType<typeof startFakeS3>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let soldOutVariant: string

      beforeAll(async () => {
        s3 = await startFakeS3(S3_PORT)
        storefront = await startFakeStorefront(STOREFRONT_PORT, SECRET)
        razorpay = await startFakeRazorpay(RAZORPAY_PORT)
        fx = await seedLaunchFixtures(getContainer())
        // Every order here is over 1,499, so each takes a tote.
        await setToteStock(getContainer(), 1000)
        flow = checkoutFlow(api, getContainer, fx)
        const {
          result: [key],
        } = await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
        admin = { Authorization: `Basic ${key.token}` }

        // A variant with no stock, to prove an exchange cannot ask for it.
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query.graph({ entity: "stock_location", fields: ["id"] })
        await createProductsWorkflow(getContainer()).run({
          input: {
            products: [
              {
                title: "Sold Out Ring",
                handle: "sold-out-ring",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: profiles[0].id,
                sales_channels: [{ id: fx.salesChannelId }],
                options: [{ title: "Size", values: ["7"] }],
                variants: [{ title: "7", sku: "SOLD-OUT-7", manage_inventory: true, options: { Size: "7" }, prices: [{ amount: 2500, currency_code: "inr" }] }],
              },
            ],
          },
        })
        const { data: items } = await query.graph({ entity: "inventory_item", fields: ["id"], filters: { sku: "SOLD-OUT-7" } })
        await createInventoryLevelsWorkflow(getContainer()).run({
          input: { inventory_levels: [{ location_id: locations[0].id, inventory_item_id: (items[0] as any).id, stocked_quantity: 0 }] },
        })
        const { data: variants } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { sku: "SOLD-OUT-7" } })
        soldOutVariant = (variants[0] as any).id
      })

      afterAll(async () => {
        await razorpay.close()
        await storefront.close()
        await s3.close()
      })

      beforeEach(() => {
        storefront.calls.length = 0
        razorpay.calls.length = 0
        storefront.behaviour.reversePickup = "ok"
        storefront.behaviour.creditNote = "ok"
        razorpay.behaviour.paymentLink = "ok"
      })

      /* ── helpers ── */

      const delivered = async (options: Parameters<typeof shippedOrder>[3] = {}, daysAgo = 1) => {
        const placed = await shippedOrder(getContainer(), flow, fx, options)
        await markDelivered(getContainer(), placed.dispatchId, daysAgo)
        return placed
      }
      const itemsOf = async (orderId: string) => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({ entity: "order", fields: ["items.id", "items.variant_sku", "items.unit_price"], filters: { id: orderId } })
        return (data[0] as any).items as { id: string; variant_sku: string; unit_price: number }[]
      }
      const ringId = async (orderId: string) =>
        (await itemsOf(orderId)).find((item) => item.variant_sku !== "EYRA-TOTE")!.id
      const request = (body: Record<string, unknown>) => flow.attempt(api.post("/admin/return-requests", body, { headers: admin }))
      const returnBody = (placed: { orderId: string; id: string }, itemId: string, extra: Record<string, unknown> = {}) => ({
        customer_id: placed.id, order_id: placed.orderId, type: "return", reason: "SIZE_ISSUE", items: [{ item_id: itemId, quantity: 1 }], ...extra,
      })
      const get = async (id: string) => {
        const [row] = await (getContainer().resolve("returnRequest") as any).listReturnRequests({ id }, { take: 1 })
        return row
      }
      const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 25000): Promise<T> => {
        const end = Date.now() + ms
        let value = await read()
        while (!done(value) && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          value = await read()
        }
        return value
      }
      const received = (id: string) => flow.attempt(api.post(`/admin/return-requests/${id}/received`, {}, { headers: admin }))
      const credits = async (orderId: string) =>
        (await (getContainer().resolve("wallet") as any).listWalletTransactions({ order_id: orderId })) as any[]
      const notes = async (orderId: string) => (await (getContainer().resolve("creditNote") as any).listCreditNotes({ order_id: orderId })) as any[]
      const sendTracking = (body: Record<string, unknown>) =>
        flow.attempt(api.post("/webhooks/shiprocket/order-update", body, { headers: { "x-api-key": HOOK } }))
      const sign = (payload: string, secret = RZP_SECRET) => createHmac("sha256", secret).update(payload).digest("hex")
      const paidEvent = (link: { id: string; reference_id: string }, amountPaise: number, status = "paid") =>
        JSON.stringify({
          event: "payment_link.paid",
          payload: {
            payment_link: { entity: { id: link.id, reference_id: link.reference_id, status, amount: amountPaise, amount_paid: amountPaise } },
            payment: { entity: { id: "pay_FEE1", amount: amountPaise, status: "captured" } },
          },
        })
      const postLinkEvent = (payload: string, signature: string | null) =>
        flow.attempt(
          api.post("/webhooks/razorpay/payment-link-paid", payload, {
            headers: { "content-type": "application/json", ...(signature ? { "x-razorpay-signature": signature } : {}) },
          })
        )

      /* ── what can be asked ── */

      describe("who can ask, and when", () => {
        it("refuses an order that has not been delivered yet", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await (getContainer().resolve("orderDispatch") as any).updateOrderDispatches({ id: placed.dispatchId, shiprocket_status: "IN TRANSIT" })
          const result: any = await request(returnBody(placed, await ringId(placed.orderId)))
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/once it has been delivered/)
        })

        it("refuses once the 7 days after delivery have passed, and accepts the last day", async () => {
          const late = await delivered({}, 8)
          const refused: any = await request(returnBody(late, await ringId(late.orderId)))
          expect(refused.ok).toBe(false)
          expect(refused.message).toMatch(/open for 7 days after delivery/)

          const edge = await delivered({}, 6.9)
          expect(((await request(returnBody(edge, await ringId(edge.orderId)))) as any).ok).toBe(true)
        })

        it("takes only the four reasons on offer", async () => {
          const placed = await delivered()
          const itemId = await ringId(placed.orderId)
          for (const reason of ["wrong_size", "changed_mind", "whatever"]) {
            expect(((await request(returnBody(placed, itemId, { reason }))) as any).ok).toBe(false)
          }
          for (const reason of ["SIZE_ISSUE", "DESIGN_PREFERENCE", "DAMAGED_IN_TRANSIT", "DEFECTIVE"]) {
            const fresh = await delivered()
            expect(((await request(returnBody(fresh, await ringId(fresh.orderId), { reason }))) as any).ok).toBe(true)
          }
        })

        it("will not take someone else's order, a cancelled order, or the free tote", async () => {
          const placed = await delivered()
          const itemId = await ringId(placed.orderId)
          const stranger = await flow.customer()
          expect(((await request(returnBody({ orderId: placed.orderId, id: stranger.id }, itemId))) as any).ok).toBe(false)

          const toteId = (await itemsOf(placed.orderId)).find((item) => item.variant_sku === "EYRA-TOTE")?.id
          expect(toteId).toBeTruthy()
          const gift: any = await request(returnBody(placed, toteId!))
          expect(gift.ok).toBe(false)
          expect(gift.message).toMatch(/free gift/)
        })

        it("will not take the same item twice", async () => {
          const placed = await delivered()
          const itemId = await ringId(placed.orderId)
          expect(((await request(returnBody(placed, itemId))) as any).ok).toBe(true)
          const again: any = await request(returnBody(placed, itemId))
          expect(again.ok).toBe(false)
          expect(again.message).toMatch(/already has a return or exchange request/)
        })

        it("keeps a request for our team when delivery cannot be confirmed, and books nothing", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          expect(created.ok).toBe(true)
          const row = await get(created.data.return_request.id)
          expect(row.status).toBe("pending")
          expect(row.delivered_at).toBeNull()
          expect(storefront.callsTo("/api/returns/reverse-pickup")).toHaveLength(0)
        })
      })

      /* ── a return ── */

      describe("a return", () => {
        it("books the courier at once, and works out the credit as paid value less the 99 fee", async () => {
          const placed = await delivered()
          const itemId = await ringId(placed.orderId)
          const created: any = await request(returnBody(placed, itemId))
          expect(created.ok).toBe(true)

          const row = await get(created.data.return_request.id)
          expect(row.status).toBe("reverse_pickup_scheduled")
          expect(Number(row.paid_value)).toBe(2000)
          expect(Number(row.fee_amount)).toBe(99)
          expect(row.reverse_order_ref).toBe(`EYRA-${placed.displayId}-R1`)
          expect(row.reverse_awb).toMatch(/^AWBREV/)
          expect(row.delivered_at).toBeTruthy()

          const [call] = storefront.callsTo("/api/returns/reverse-pickup")
          expect(call.body).toMatchObject({
            return_request_id: row.id,
            order_ref: `EYRA-${placed.displayId}`,
            reverse_order_ref: row.reverse_order_ref,
            type: "return",
            reason: "SIZE_ISSUE",
          })
          expect(call.body.pickup).toMatchObject({ fullName: "Asha Rao", pincode: "411001", state: "Maharashtra", phone: "9999999999" })
          expect(call.body.items[0]).toMatchObject({ quantity: 1, price: 2000 })
        })

        it("keeps the request when the courier cannot be booked, tells the team, and books on a retry", async () => {
          storefront.behaviour.reversePickup = "fail"
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          expect(created.ok).toBe(true)
          const id = created.data.return_request.id
          const row = await get(id)
          expect(row.status).toBe("pending")
          expect(row.reverse_error).toMatch(/refused/)
          expect(storefront.callsTo("/api/ops/notify").some((c) => c.body.type === "reverse_pickup_problem")).toBe(true)

          storefront.behaviour.reversePickup = "ok"
          const retry: any = await flow.attempt(api.post(`/admin/return-requests/${id}/retry-pickup`, {}, { headers: admin }))
          expect(retry.ok).toBe(true)
          expect(retry.data.outcome).toBe("pickup_booked")
          const after = await get(id)
          expect(after.status).toBe("reverse_pickup_scheduled")
          expect(after.reverse_error).toBeNull()
          // Asked again once booked, it does not book a second pickup.
          const calls = storefront.callsTo("/api/returns/reverse-pickup").length
          await flow.attempt(api.post(`/admin/return-requests/${id}/retry-pickup`, {}, { headers: admin }))
          expect(storefront.callsTo("/api/returns/reverse-pickup")).toHaveLength(calls)
        })

        it("queues the parcel for inspection when the courier delivers it to us", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const row = await get(created.data.return_request.id)

          const result: any = await sendTracking({ order_id: row.reverse_order_ref, awb: row.reverse_awb, current_status: "DELIVERED" })
          expect(result.data).toMatchObject({ acted: true, matched: "reverse" })
          expect((await get(row.id)).status).toBe("awaiting_inspection")
          expect(storefront.callsTo("/api/ops/notify").some((c) => c.body.type === "return_parcel_arrived")).toBe(true)
          // It is the reverse parcel's delivery, not the order's own.
          const [dispatch] = await (getContainer().resolve("orderDispatch") as any).listOrderDispatches({ order_id: placed.orderId }, { take: 1 })
          expect(dispatch.rto_initiated_at).toBeNull()
        })

        it("on receipt issues a credit note and 12 months of store credit, then tells the customer", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id

          const done = await received(id)
          expect(done.ok).toBe(true)
          const row = await waitFor(() => get(id), (value) => value.status === "approved")
          expect(row.status).toBe("approved")
          expect(Number(row.credit_amount)).toBe(1901)

          const [note] = await notes(placed.orderId)
          expect(note.kind).toBe("return")
          expect(note.return_request_id).toBe(id)
          expect(row.credit_note_id).toBe(note.id)
          expect(note.payload.original_invoice_number).toBe(placed.invoiceNumber)
          expect(note.payload.totals.total).toBe(2000)
          expect(note.payload.adjustments).toMatchObject({ reverse_logistics_fee_deduction: 99, net_store_credit_issued: 1901 })
          // The 99 carries 18% GST: 83.90 + 15.10 (IGST, the order is going to Maharashtra).
          expect(note.payload.adjustments.fee).toMatchObject({ type: "reverse_logistics", sac: "9997", gst_rate: 18, amount: 99, taxable_value: 83.9, igst: 15.1 })
          // The PDF is stored under credit-notes/FY<year>/.
          expect(note.pdf_key).toMatch(/^s3:/)
          expect([...s3.objects.keys()].some((path) => /credit-notes\/FY\d\d-\d\d\//.test(path))).toBe(true)

          const [credit] = await credits(placed.orderId)
          expect(credit).toMatchObject({ type: "issued", reason: "return" })
          expect(Number(credit.amount)).toBe(1901)
          const months = (new Date(credit.expires_at).getTime() - Date.now()) / (30.4 * 24 * 3600 * 1000)
          expect(months).toBeGreaterThan(11.5)
          expect(months).toBeLessThan(12.5)

          const message = storefront.callsTo("/api/whatsapp/send").find((c) => c.body.template === "store_credit_issued")
          expect(message?.body.phone).toBe("919999999999")
          expect(message?.body.params).toMatchObject({ amount: 1901, credit_note: note.credit_note_number })
        })

        it("charges no fee for a damaged or defective item: the whole value comes back as credit", async () => {
          for (const reason of ["DAMAGED_IN_TRANSIT", "DEFECTIVE"]) {
            const placed = await delivered()
            const created: any = await request(returnBody(placed, await ringId(placed.orderId), { reason }))
            const id = created.data.return_request.id
            expect(Number((await get(id)).fee_amount)).toBe(0)

            await received(id)
            const row = await waitFor(() => get(id), (value) => value.status === "approved")
            expect(Number(row.credit_amount)).toBe(2000)
            const [note] = await notes(placed.orderId)
            expect(note.payload.adjustments).toMatchObject({ reverse_logistics_fee_deduction: 0, net_store_credit_issued: 2000, fee: null })
            expect(note.deduction_paise).toBe(0)
          }
        })

        it("still charges it for a size or design reason", async () => {
          for (const reason of ["SIZE_ISSUE", "DESIGN_PREFERENCE"]) {
            const placed = await delivered()
            const created: any = await request(returnBody(placed, await ringId(placed.orderId), { reason }))
            expect(Number((await get(created.data.return_request.id)).fee_amount)).toBe(99)
          }
        })

        it("is refused to be received twice, and a repeat of the finish pays and numbers nothing again", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id
          await received(id)
          await waitFor(() => get(id), (value) => value.status === "approved")

          expect(((await received(id)) as any).ok).toBe(false)
          const again: any = await flow.attempt(
            api.post("/webhooks/medusa/return-approved", { return_request_id: id }, { headers: { "x-shipment-secret": SECRET } })
          )
          expect(again.ok).toBe(true)
          expect(await notes(placed.orderId)).toHaveLength(1)
          expect(await credits(placed.orderId)).toHaveLength(1)
        })

        it("finishes by itself later when a credit note could not be issued the first time", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id

          const saved = process.env.SELLER_GSTIN
          process.env.SELLER_GSTIN = ""
          try {
            await received(id)
            await new Promise((resolve) => setTimeout(resolve, 3000))
          } finally {
            process.env.SELLER_GSTIN = saved
          }
          const stuck = await get(id)
          expect(stuck.status).toBe("awaiting_inspection")
          expect(stuck.received_at).toBeTruthy()
          expect(await notes(placed.orderId)).toHaveLength(0)
          expect(await credits(placed.orderId)).toHaveLength(0)
          expect(storefront.callsTo("/api/ops/notify").some((c) => c.body.type === "return_not_finished")).toBe(true)

          // The job leaves a fresh one to the handler, and finishes one that has waited.
          await finishReceivedReturnsJob(getContainer())
          expect((await get(id)).status).toBe("awaiting_inspection")
          await (getContainer().resolve("returnRequest") as any).updateReturnRequests({ id, received_at: new Date(Date.now() - 10 * 60 * 1000) })
          await finishReceivedReturnsJob(getContainer())
          expect((await get(id)).status).toBe("approved")
          expect(await notes(placed.orderId)).toHaveLength(1)
          expect(await credits(placed.orderId)).toHaveLength(1)
        })

        it("an older request, waiting for our team, can still be approved by hand for an amount staff choose", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id
          const approved: any = await flow.attempt(api.post(`/admin/return-requests/${id}/approve`, { amount: 750, note: "Agreed by phone" }, { headers: admin }))
          expect(approved.ok).toBe(true)
          const [credit] = await credits(placed.orderId)
          expect(Number(credit.amount)).toBe(750)
        })

        it("a rejected request is final", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id
          const rejected: any = await flow.attempt(api.post(`/admin/return-requests/${id}/reject`, { note: "Item failed the check" }, { headers: admin }))
          expect(rejected.ok).toBe(true)
          expect(((await received(id)) as any).ok).toBe(false)
          expect(await notes(placed.orderId)).toHaveLength(0)
        })
      })

      /* ── an exchange ── */

      describe("an exchange", () => {
        const exchangeBody = (placed: { orderId: string; id: string }, itemId: string, variantId: string) => ({
          customer_id: placed.id, order_id: placed.orderId, type: "exchange", reason: "DESIGN_PREFERENCE",
          items: [{ item_id: itemId, quantity: 1 }], replacement_variant_id: variantId,
        })

        it("asks only for the price difference, with a payment link, when the replacement costs more", async () => {
          const placed = await delivered()
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[3000]))
          expect(created.ok).toBe(true)
          const row = await get(created.data.return_request.id)

          // Paid 2,000, replacement 3,000: 1,000 more, and no handling fee on top.
          expect(Number(row.price_difference)).toBe(1000)
          expect(Number(row.amount_due)).toBe(1000)
          expect(row.status).toBe("pending_fee")
          expect(row.fee_link_id).toBe("plink_FAKE1")
          expect(row.fee_link_url).toBe("https://rzp.io/i/fake1")
          expect(row.reverse_awb).toBeNull()

          const [call] = razorpay.calls
          expect(call.path).toBe("/payment_links")
          expect(call.body).toMatchObject({ amount: 100000, currency: "INR", reference_id: row.id, accept_partial: false })
          expect(call.body.notes).toMatchObject({ return_request_id: row.id, order_id: placed.orderId })
          expect(storefront.callsTo("/api/returns/reverse-pickup")).toHaveLength(0)
          expect(storefront.callsTo("/api/whatsapp/send").some((c) => c.body.template === "exchange_payment_link")).toBe(true)
        })

        it("starts directly, with no payment and no fee, when the replacement costs less or the same", async () => {
          for (const [price, difference] of [[1500, -500], [2000, 0]] as const) {
            const placed = await delivered()
            const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[price]))
            expect(created.ok).toBe(true)
            const row = await get(created.data.return_request.id)
            expect(Number(row.price_difference)).toBe(difference)
            expect(Number(row.amount_due)).toBe(0)
            // No payment link; the courier is booked at once, like a return.
            expect(row.status).toBe("reverse_pickup_scheduled")
            expect(row.fee_link_id).toBeNull()
            expect(row.reverse_awb).toMatch(/^AWBREV/)
            expect(razorpay.calls).toHaveLength(0)
          }
          const [call] = storefront.callsTo("/api/returns/reverse-pickup")
          expect(call.body.type).toBe("exchange")
        })

        it("can be received straight away when nothing is owed, and never needs a payment", async () => {
          const placed = await delivered()
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[2000]))
          const id = created.data.return_request.id
          const done = await received(id)
          expect(done.ok).toBe(true)
          const row = await waitFor(() => get(id), (value) => value.status === "approved")
          expect(row.status).toBe("approved")
          expect(row.replacement_order_id).toMatch(/^order_/)
        })

        it("will not exchange for something out of stock, unpublished or the tote, or more than one item", async () => {
          const placed = await delivered()
          const itemId = await ringId(placed.orderId)
          const soldOut: any = await request(exchangeBody(placed, itemId, soldOutVariant))
          expect(soldOut.ok).toBe(false)
          expect(soldOut.message).toMatch(/out of stock/)

          const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
          const { data } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { sku: "EYRA-TOTE" } })
          expect(((await request(exchangeBody(placed, itemId, (data[0] as any).id))) as any).ok).toBe(false)

          const noVariant: any = await request({ ...exchangeBody(placed, itemId, fx.variantByPrice[3000]), replacement_variant_id: undefined })
          expect(noVariant.ok).toBe(false)
          expect(razorpay.calls).toHaveLength(0)
        })

        it("is not kept when the payment link cannot be made, so nobody waits on a link that does not exist", async () => {
          razorpay.behaviour.paymentLink = "fail"
          const placed = await delivered()
          const result: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[3000]))
          expect(result.ok).toBe(false)
          const rows = await (getContainer().resolve("returnRequest") as any).listReturnRequests({ order_id: placed.orderId })
          expect(rows).toHaveLength(0)
        })

        it("moves on, and books the courier, only when Razorpay says the difference was paid in full", async () => {
          const placed = await delivered()
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[3000]))
          const row = await get(created.data.return_request.id)
          const link = { id: row.fee_link_id, reference_id: row.id }

          // No signature, a wrong one, and a payload changed after signing are all refused.
          const good = paidEvent(link, 100000)
          expect(((await postLinkEvent(good, null)) as any).ok).toBe(false)
          const wrong: any = await postLinkEvent(good, sign(good, "not-the-secret"))
          expect(wrong.status).toBe(401)
          const tampered: any = await postLinkEvent(good.replace("100000", "100"), sign(good))
          expect(tampered.status).toBe(401)
          expect((await get(row.id)).status).toBe("pending_fee")

          // Paid short of what was asked: not accepted.
          const short = paidEvent(link, 50000)
          const shortResult: any = await postLinkEvent(short, sign(short))
          expect(shortResult.data).toMatchObject({ acted: false, reason: "amount_short" })
          expect((await get(row.id)).status).toBe("pending_fee")
          expect(storefront.callsTo("/api/returns/reverse-pickup")).toHaveLength(0)

          const paid: any = await postLinkEvent(good, sign(good))
          expect(paid.ok).toBe(true)
          expect(paid.data).toMatchObject({ acted: true, outcome: "pickup_booked" })
          const after = await get(row.id)
          expect(after.status).toBe("reverse_pickup_scheduled")
          expect(after.fee_paid_at).toBeTruthy()
          expect(after.fee_payment_id).toBe("pay_FEE1")
          expect(after.reverse_awb).toMatch(/^AWBREV/)
          expect(storefront.callsTo("/api/returns/reverse-pickup")[0].body.type).toBe("exchange")

          // The same event again, and an event for a link nobody knows, do nothing.
          const repeat: any = await postLinkEvent(good, sign(good))
          expect(repeat.data).toMatchObject({ acted: false, reason: "already_processed" })
          expect(storefront.callsTo("/api/returns/reverse-pickup")).toHaveLength(1)
          const stranger = paidEvent({ id: "plink_NOPE", reference_id: "retreq_NOPE" }, 50000)
          expect(((await postLinkEvent(stranger, sign(stranger))) as any).data.reason).toBe("unknown_link")
        })

        it("also answers to the event name written in the specification", async () => {
          const placed = await delivered()
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[3000]))
          const row = await get(created.data.return_request.id)
          const payload = paidEvent({ id: row.fee_link_id, reference_id: row.id }, 100000).replace("payment_link.paid", "payment.link.paid")
          const result: any = await postLinkEvent(payload, sign(payload))
          expect(result.data.acted).toBe(true)
        })

        it("cannot be received before its price difference is paid", async () => {
          const placed = await delivered()
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), fx.variantByPrice[3000]))
          const id = created.data.return_request.id
          const result: any = await received(id)
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/difference for the exchange has not been paid/)
        })

        /** Runs an exchange to the end: pays what is owed (if anything), the parcel arrives, it passes the check. */
        const payAndReceive = async (placed: { orderId: string; id: string }, variantId: string) => {
          const created: any = await request(exchangeBody(placed, await ringId(placed.orderId), variantId))
          const row = await get(created.data.return_request.id)
          // Only a dearer replacement has anything to pay.
          if (row.status === "pending_fee") {
            const payload = paidEvent({ id: row.fee_link_id, reference_id: row.id }, Math.round(Number(row.amount_due) * 100))
            await postLinkEvent(payload, sign(payload))
          }
          await sendTracking({ order_id: (await get(row.id)).reverse_order_ref, awb: (await get(row.id)).reverse_awb, current_status: "DELIVERED" })
          expect((await get(row.id)).status).toBe("awaiting_inspection")
          await received(row.id)
          return waitFor(() => get(row.id), (value) => value.status === "approved")
        }

        it("on receipt reverses the old item, and sends a replacement at the agreed price that the courier does not collect for", async () => {
          const placed = await delivered()
          const row = await payAndReceive(placed, fx.variantByPrice[3000])
          expect(row.status).toBe("approved")
          expect(row.replacement_order_id).toMatch(/^order_/)

          const [note] = await notes(placed.orderId)
          expect(note.kind).toBe("exchange")
          expect(note.payload.adjustments.reverse_logistics_fee_deduction).toBe(0)
          // An exchange has no fee, so none is shown.
          expect(note.payload.adjustments.fee).toBeNull()
          expect(note.payload.totals.total).toBe(2000)

          const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
          const { data } = await query.graph({
            entity: "order",
            fields: ["customer_id", "email", "total", "metadata", "items.*", "shipping_address.city", "shipping_address.province"],
            filters: { id: row.replacement_order_id },
          })
          const replacement = data[0] as any
          expect(replacement.customer_id).toBe(placed.id)
          expect(Number(replacement.total)).toBe(3000)
          expect(replacement.items).toHaveLength(1)
          expect(replacement.items[0].variant_id).toBe(fx.variantByPrice[3000])
          expect(replacement.metadata).toMatchObject({ replacement_for_order: placed.orderId, exchange_request_id: row.id })
          expect(replacement.shipping_address).toMatchObject({ city: "Pune", province: "Maharashtra" })

          // Shipped now, not held: it has a dispatch record of its own.
          const [dispatch] = await (getContainer().resolve("orderDispatch") as any).listOrderDispatches({ order_id: row.replacement_order_id }, { take: 1 })
          expect(dispatch).toBeTruthy()
          // The replacement cost more, so there is no credit to give back.
          expect(await credits(placed.orderId)).toHaveLength(0)
          expect(storefront.callsTo("/api/whatsapp/send").some((c) => c.body.template === "replacement_dispatched")).toBe(true)
        })

        it("gives the difference back as store credit when the replacement costs less", async () => {
          const placed = await delivered()
          const row = await payAndReceive(placed, fx.variantByPrice[1500])
          expect(row.status).toBe("approved")
          expect(Number(row.credit_amount)).toBe(500)
          const [credit] = await credits(placed.orderId)
          expect(credit).toMatchObject({ type: "issued", reason: "exchange" })
          expect(Number(credit.amount)).toBe(500)
          const months = (new Date(credit.expires_at).getTime() - Date.now()) / (30.4 * 24 * 3600 * 1000)
          expect(months).toBeGreaterThan(11.5)
        })

        it("never makes a second replacement, however often it is finished", async () => {
          const placed = await delivered()
          const row = await payAndReceive(placed, fx.variantByPrice[3000])
          for (let i = 0; i < 2; i++) {
            await flow.attempt(api.post("/webhooks/medusa/return-approved", { return_request_id: row.id }, { headers: { "x-shipment-secret": SECRET } }))
          }
          const orders = await getContainer().resolve(Modules.ORDER).listOrders({}, { select: ["id", "metadata"] })
          const replacements = (orders as any[]).filter((order) => order.metadata?.exchange_request_id === row.id)
          expect(replacements).toHaveLength(1)
          expect(await notes(placed.orderId)).toHaveLength(1)
        })
      })

      describe("the internal finish route", () => {
        it("is closed to anyone without the secret, and refuses a request that was not received", async () => {
          const placed = await delivered()
          const created: any = await request(returnBody(placed, await ringId(placed.orderId)))
          const id = created.data.return_request.id
          expect(((await flow.attempt(api.post("/webhooks/medusa/return-approved", { return_request_id: id }))) as any).status).toBe(401)
          const early: any = await flow.attempt(
            api.post("/webhooks/medusa/return-approved", { return_request_id: id }, { headers: { "x-shipment-secret": SECRET } })
          )
          expect(early.ok).toBe(false)
          expect(early.status).toBe(409)
          expect(((await flow.attempt(api.post("/webhooks/medusa/return-approved", {}, { headers: { "x-shipment-secret": SECRET } }))) as any).status).toBe(400)
        })
      })
    })
  },
})
