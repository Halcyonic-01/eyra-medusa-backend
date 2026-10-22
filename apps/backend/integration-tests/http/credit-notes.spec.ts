import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import generateCreditNotePdfsJob from "../../src/jobs/generate-credit-note-pdfs"
import { financialYearLabel } from "../../src/modules/order-dispatch/invoice"
import { CreditNoteError } from "../../src/modules/credit-note/document"
import { issueCreditNote } from "../../src/modules/credit-note/issue"
import { issueCreditNoteWorkflow } from "../../src/workflows/issue-credit-note"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"
import { shippedOrder } from "./helpers/shipped-order"

const S3_PORT = 18741
const STOREFRONT_PORT = 18742
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
process.env.S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`
process.env.S3_FORCE_PATH_STYLE = "true"
process.env.STOREFRONT_REVALIDATE_URL = `http://127.0.0.1:${STOREFRONT_PORT}/api/revalidate`
process.env.STOREFRONT_REVALIDATE_SECRET = "integration-shared-secret"
process.env.STOREFRONT_SHIPMENT_SECRET = SECRET
process.env.SELLER_GSTIN = "20AAJCE7349A1Z1"
process.env.SELLER_STATE = "Jharkhand"
// Orders are held, so nothing here starts a real shipment; the tests mark them shipped themselves.
process.env.ORDER_CANCEL_WINDOW_MINUTES = "120"
process.env.ORDER_DISPATCH_ENABLED = "true"

jest.setTimeout(300000)

const FY = financialYearLabel(new Date())

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("credit notes", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let admin: Record<string, string>
      let s3: Awaited<ReturnType<typeof startFakeS3>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>

      beforeAll(async () => {
        s3 = await startFakeS3(S3_PORT)
        storefront = await startFakeStorefront(STOREFRONT_PORT, SECRET)
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
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
        storefront.behaviour.creditNote = "ok"
      })

      const order = () => shippedOrder(getContainer(), flow, fx)
      const counter = async () => {
        const pg = getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
        const result = await pg.raw(`SELECT last_seq FROM credit_note_counter WHERE fy = ?`, [FY])
        return result.rows[0] ? Number(result.rows[0].last_seq) : 0
      }
      const returnAll = (orderId: string, source: string, extra: Record<string, unknown> = {}) =>
        issueCreditNote(getContainer(), {
          order_id: orderId,
          kind: "return",
          reason: "SIZE_ISSUE",
          source_key: source,
          returned: "all",
          reverse_cod: false,
          deduction: 99,
          ...extra,
        } as any)

      describe("numbering and content", () => {
        it("numbers the first note CN/<year>/0001 and carries what the rules require", async () => {
          const placed = await order()
          const { status, note } = await returnAll(placed.orderId, `test:first:${placed.orderId}`)

          expect(status).toBe("issued")
          expect(note.credit_note_number).toBe(`CN/${FY}/${String(await counter()).padStart(4, "0")}`)
          expect(note.credit_note_number).toMatch(/^CN\/\d\d-\d\d\/\d{4}$/)

          const document = note.payload
          expect(document.credit_note_number).toBe(note.credit_note_number)
          expect(document.credit_note_date).toMatch(/\+05:30$/)
          expect(document.original_invoice_number).toBe(placed.invoiceNumber)
          expect(document.original_invoice_date).toBe("2026-10-15T10:30:00+05:30")
          expect(document.customer_details.state).toBe("Maharashtra")
          // 2,000 of jewellery to another state: 3% GST all IGST. 2,000 x 3 / 103 = 58.25.
          expect(document.line_items).toHaveLength(1)
          expect(document.line_items[0]).toMatchObject({ hsn_sac: "7113", taxable_value: 1941.75, gst_rate: 3, igst: 58.25, total: 2000 })
          expect(document.adjustments).toMatchObject({ reverse_logistics_fee_deduction: 99, net_store_credit_issued: 1901 })
          // The Cash on Delivery charge on the order is not part of a return.
          expect(document.totals.total).toBe(2000)
          expect(Number(note.total_paise)).toBe(200000)
          expect(Number(note.net_credit_paise)).toBe(190100)
        })

        it("numbers one after another with no gap, however often a source is asked for again", async () => {
          const a = await order()
          const b = await order()
          const before = await counter()

          const first = await returnAll(a.orderId, `test:seq-a:${a.orderId}`)
          const repeat = await returnAll(a.orderId, `test:seq-a:${a.orderId}`)
          const second = await returnAll(b.orderId, `test:seq-b:${b.orderId}`)

          expect(repeat.status).toBe("exists")
          expect(repeat.note.credit_note_number).toBe(first.note.credit_note_number)
          expect(first.note.credit_note_number).toBe(`CN/${FY}/${String(before + 1).padStart(4, "0")}`)
          expect(second.note.credit_note_number).toBe(`CN/${FY}/${String(before + 2).padStart(4, "0")}`)
          expect(await counter()).toBe(before + 2)
        })

        it("gives one note to several requests for the same source at once", async () => {
          const placed = await order()
          const before = await counter()
          const results = await Promise.all(
            [1, 2, 3, 4].map(() => returnAll(placed.orderId, `test:race:${placed.orderId}`).catch((error) => error))
          )
          const numbers = new Set(results.filter((r) => r.note).map((r) => r.note.credit_note_number))
          expect(numbers.size).toBe(1)
          expect(await counter()).toBe(before + 1)
        })

        it("takes no number when the order has no tax invoice", async () => {
          const who = await flow.customer()
          const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
          await flow.setMode(cartId, "cod")
          const orderId = await flow.placeCod(cartId, who.email)
          const before = await counter()
          await expect(returnAll(orderId, `test:noinvoice:${orderId}`)).rejects.toThrow(/no tax invoice/)
          expect(await counter()).toBe(before)
        })

        it("takes no number when the seller's GSTIN is missing", async () => {
          const placed = await order()
          const before = await counter()
          const saved = process.env.SELLER_GSTIN
          process.env.SELLER_GSTIN = ""
          try {
            await expect(returnAll(placed.orderId, `test:nogstin:${placed.orderId}`)).rejects.toThrow(CreditNoteError)
          } finally {
            process.env.SELLER_GSTIN = saved
          }
          expect(await counter()).toBe(before)
        })

        it("spreads an order's discount over its lines and reverses each line at its own net value", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx, {
            items: [{ variantId: fx.variantByPrice[1500] }, { variantId: fx.variantByPrice[1000] }],
            code: "WELCOME200",
          })
          // 2,500 of jewellery with 200 off: the two lines take 120 and 80 of it.
          const { note } = await issueCreditNote(getContainer(), {
            order_id: placed.orderId,
            kind: "return",
            reason: "DEFECTIVE",
            source_key: `test:disc:${placed.orderId}`,
            returned: "all",
            reverse_cod: false,
            deduction: 0,
          })
          const totals = note.payload.totals
          expect(totals.total).toBe(2300)
          expect(Math.round(totals.taxable_value * 100) + Math.round(totals.total_tax * 100)).toBe(230000)
          expect(note.payload.line_items.map((line: any) => line.total).sort((a: number, b: number) => a - b)).toEqual([920, 1380])
        })

        it("credits the units of a line in turn, never more than the invoice has", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx, { items: [{ variantId: fx.variantByPrice[1000], quantity: 3 }] })
          const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
          const { data } = await query.graph({ entity: "order", fields: ["items.id"], filters: { id: placed.orderId } })
          const itemId = (data[0] as any).items[0].id

          const one = (n: number) =>
            issueCreditNote(getContainer(), {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:unit:${placed.orderId}:${n}`, returned: [{ item_id: itemId, quantity: 1 }], reverse_cod: false, deduction: 0,
            })
          const totals: number[] = []
          for (const n of [1, 2, 3]) totals.push((await one(n)).note.payload.totals.total)
          expect(totals).toEqual([1000, 1000, 1000])
          await expect(one(4)).rejects.toThrow(/left to credit|nothing/)
        })
      })

      describe("the PDF", () => {
        it("is drawn from the stored note, kept in credit-notes/FY<year>/, and drawn only once", async () => {
          const placed = await order()
          const { result } = await issueCreditNoteWorkflow(getContainer()).run({
            input: {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:pdf:${placed.orderId}`, returned: "all", reverse_cod: false, deduction: 99,
            },
          })
          expect(result.pdf.status).toBe("stored")
          expect(storefront.callsTo("/api/credit-notes/render")).toHaveLength(1)
          // The storefront is sent the issued document, so it can only draw what was issued.
          const sent = storefront.callsTo("/api/credit-notes/render")[0].body.credit_note
          expect(sent.credit_note_number).toBe(result.credit_note_number)
          expect(sent.line_items[0].total).toBe(2000)

          const key = (result.pdf as any).key as string
          expect(key.startsWith("s3:")).toBe(true)
          const stored = [...s3.objects.entries()].find(([path]) => path.includes(`credit-notes/FY${FY}/`))
          expect(stored).toBeTruthy()
          expect(stored![1].headers["x-amz-acl"]).toBe("private")
          expect(stored![0]).toContain(result.credit_note_number.replace(/\//g, "-"))

          // A second run finds it and does nothing.
          const again = await issueCreditNoteWorkflow(getContainer()).run({
            input: {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:pdf:${placed.orderId}`, returned: "all", reverse_cod: false, deduction: 99,
            },
          })
          expect(again.result.status).toBe("exists")
          expect(again.result.pdf.status).toBe("exists")
          expect(storefront.callsTo("/api/credit-notes/render")).toHaveLength(1)
        })

        it("keeps the note, and its number, when the storefront is down; a job draws it later", async () => {
          storefront.behaviour.creditNote = "down"
          const placed = await order()
          const { result } = await issueCreditNoteWorkflow(getContainer()).run({
            input: {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:down:${placed.orderId}`, returned: "all", reverse_cod: false, deduction: 99,
            },
          })
          expect(result.pdf.status).toBe("failed")
          expect(result.credit_note_number).toMatch(/^CN\//)

          const service = getContainer().resolve("creditNote") as any
          const [saved] = await service.listCreditNotes({ id: result.credit_note_id })
          expect(saved.pdf_key).toBeNull()
          expect(saved.pdf_error).toMatch(/render_failed/)
          expect(saved.pdf_attempts).toBe(1)

          // Not due yet: the job leaves it for its retry time.
          await generateCreditNotePdfsJob(getContainer())
          expect((await service.listCreditNotes({ id: result.credit_note_id }))[0].pdf_key).toBeNull()

          storefront.behaviour.creditNote = "ok"
          await service.updateCreditNotes({ id: result.credit_note_id, pdf_retry_at: new Date(Date.now() - 1000) })
          await generateCreditNotePdfsJob(getContainer())
          const [after] = await service.listCreditNotes({ id: result.credit_note_id })
          expect(after.pdf_key).toMatch(/^s3:/)
          expect(after.pdf_error).toBeNull()
        })

        it("is refused when the storefront draws a different number", async () => {
          storefront.behaviour.creditNote = "wrong_number"
          const placed = await order()
          const { result } = await issueCreditNoteWorkflow(getContainer()).run({
            input: {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:wrongnum:${placed.orderId}`, returned: "all", reverse_cod: false, deduction: 99,
            },
          })
          expect(result.pdf.status).toBe("failed")
          expect((result.pdf as any).code).toBe("number_mismatch")
        })
      })

      describe("admin routes", () => {
        it("lists an order's notes, serves the PDF, and is behind the sign-in", async () => {
          const placed = await order()
          const { result } = await issueCreditNoteWorkflow(getContainer()).run({
            input: {
              order_id: placed.orderId, kind: "return", reason: "SIZE_ISSUE",
              source_key: `test:routes:${placed.orderId}`, returned: "all", reverse_cod: false, deduction: 99,
            },
          })

          const unsigned = await flow.attempt(api.get(`/admin/credit-notes?order_id=${placed.orderId}`))
          expect(unsigned.ok).toBe(false)

          const list: any = (await api.get(`/admin/credit-notes?order_id=${placed.orderId}`, { headers: admin })).data
          expect(list.count).toBe(1)
          expect(list.credit_notes[0]).toMatchObject({
            credit_note_number: result.credit_note_number, kind: "return", total: 2000, deduction: 99, net_credit: 1901, has_pdf: true,
          })

          const pdf = await api.get(`/admin/credit-notes/${result.credit_note_id}/pdf`, { headers: admin, responseType: "arraybuffer" })
          expect(pdf.headers["content-type"]).toContain("application/pdf")
          expect(pdf.headers["cache-control"]).toContain("no-store")
          expect(Buffer.from(pdf.data).subarray(0, 5).toString()).toBe("%PDF-")
          expect(Buffer.from(pdf.data).toString()).toContain(result.credit_note_number)
        })

        it("exports the month as a GSTR-1 CSV", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx, { mode: "cod" })
          const { note } = await returnAll(placed.orderId, `test:gstr1:${placed.orderId}`)
          const month = note.payload.credit_note_date!.slice(0, 7)

          const res = await api.get(`/admin/credit-notes/gstr1?month=${month}`, { headers: admin })
          expect(res.headers["content-type"]).toContain("text/csv")
          expect(res.headers["content-disposition"]).toContain(`gstr1-credit-notes-${month}.csv`)
          const rows = String(res.data).trim().split("\r\n")
          expect(rows[0]).toContain('"Seller GSTIN"')
          const mine = rows.find((row) => row.includes(note.credit_note_number))!
          expect(mine).toContain('"20AAJCE7349A1Z1"')
          expect(mine).toContain(`"${placed.invoiceNumber}"`)
          expect(mine).toContain('"7113"')
          expect(mine).toContain('1941.75,0.00,0.00,58.25,2000.00,"Credit note line"')
          // The 99 kept comes after it as its own row, with its own 18% GST.
          const feeRow = rows.find((row) => row.includes(note.credit_note_number) && row.includes('"Fee retained"'))!
          expect(feeRow).toContain('"9997","Reverse logistics fee",1,18.00,83.90,0.00,0.00,15.10,99.00')

          const other: any = await flow.attempt(api.get(`/admin/credit-notes/gstr1?month=nonsense`, { headers: admin }))
          expect(other.ok).toBe(false)
        })
      })

      describe("an order cancelled by staff after it shipped", () => {
        const waitForNote = async (orderId: string) => {
          const service = getContainer().resolve("creditNote") as any
          for (let i = 0; i < 80; i++) {
            const [row] = await service.listCreditNotes({ order_id: orderId })
            if (row) return row
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          return null
        }

        it("gets a credit note for everything, including the Cash on Delivery charge, when no delivery was attempted", async () => {
          const placed = await order()
          const cancel = await flow.attempt(api.post(`/admin/orders/${placed.orderId}/cancel`, {}, { headers: admin }))
          expect(cancel.ok).toBe(true)

          const note = await waitForNote(placed.orderId)
          expect(note).toBeTruthy()
          expect(note.kind).toBe("cancellation")
          expect(note.payload.line_items.map((line: any) => line.hsn_sac)).toEqual(["7113", "9997"])
          // 2,000 of jewellery and the 99 charge (83.90 + 15.10 at 18%).
          expect(note.payload.totals.total).toBe(2099)
          expect(note.payload.line_items[1]).toMatchObject({ taxable_value: 83.9, gst_rate: 18, igst: 15.1, total: 99 })
          // A Cash on Delivery order nobody paid for: the invoice is reversed in full, no money goes back.
          expect(note.payload.adjustments).toMatchObject({ reverse_logistics_fee_deduction: 0, net_refund_amount: 0, credit_method: "none" })
        })

        it("keeps the Cash on Delivery charge when the courier already tried to deliver", async () => {
          const placed = await order()
          const dispatch = getContainer().resolve("orderDispatch") as any
          await dispatch.updateOrderDispatches({ id: placed.dispatchId, delivery_attempted_at: new Date() })

          const cancel = await flow.attempt(api.post(`/admin/orders/${placed.orderId}/cancel`, {}, { headers: admin }))
          expect(cancel.ok).toBe(true)

          const note = await waitForNote(placed.orderId)
          expect(note.payload.line_items.map((line: any) => line.hsn_sac)).toEqual(["7113"])
          expect(note.payload.totals.total).toBe(2000)
        })

        it("gets no credit note when it never shipped, because there was no invoice", async () => {
          const who = await flow.customer()
          const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
          await flow.setMode(cartId, "cod")
          const orderId = await flow.placeCod(cartId, who.email)
          const dispatch = getContainer().resolve("orderDispatch") as any
          for (let i = 0; i < 40; i++) {
            const [row] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })
            if (row) break
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          const cancel = await flow.attempt(api.post(`/admin/orders/${orderId}/cancel`, {}, { headers: admin }))
          expect(cancel.ok).toBe(true)
          await new Promise((resolve) => setTimeout(resolve, 2500))
          const service = getContainer().resolve("creditNote") as any
          expect(await service.listCreditNotes({ order_id: orderId })).toHaveLength(0)
        })
      })
    })
  },
})
