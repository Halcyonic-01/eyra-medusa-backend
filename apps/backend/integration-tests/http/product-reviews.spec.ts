import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import sendReviewRequests from "../../src/jobs/send-review-requests"
import { PRODUCT_REVIEW_MODULE } from "../../src/modules/product-review"
import { linkSecret, linkToken } from "../../src/modules/product-review/tokens"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeS3 } from "./helpers/fake-servers"
import { startFakeStorefront } from "./helpers/fake-storefront"
import { seedLaunchFixtures, setToteStock, type LaunchFixtures } from "./helpers/launch-fixtures"
import { shippedOrder } from "./helpers/shipped-order"

const S3_PORT = 18771
const STOREFRONT_PORT = 18772
const SECRET = "integration-shipment-secret"
const HOOK = "integration-shiprocket-hook"

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
process.env.ORDER_DISPATCH_ENABLED = "true"
process.env.REVIEW_LINK_SECRET = "integration-review-secret"
// Links follow the (fake) storefront here, whatever a local .env says.
process.env.REVIEW_LINK_BASE_URL = ""

jest.setTimeout(300000)

// A 1x1 PNG, a real image by its bytes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("product reviews", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let s3: Awaited<ReturnType<typeof startFakeS3>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>
      let admin: Record<string, string>
      let store: Record<string, string>

      beforeAll(async () => {
        s3 = await startFakeS3(S3_PORT)
        storefront = await startFakeStorefront(STOREFRONT_PORT, SECRET)
        fx = await seedLaunchFixtures(getContainer())
        await setToteStock(getContainer(), 1000)
        flow = checkoutFlow(api, getContainer, fx)
        const {
          result: [key],
        } = await createApiKeysWorkflow(getContainer()).run({
          input: { api_keys: [{ title: "admin", type: "secret", created_by: "" }] },
        })
        admin = { Authorization: `Basic ${key.token}` }
        store = { "x-publishable-api-key": fx.publishableKey }
      })
      afterAll(async () => {
        await storefront.close()
        await s3.close()
      })
      beforeEach(() => {
        storefront.calls.length = 0
        storefront.behaviour.email = "ok"
        storefront.behaviour.whatsapp = "ok"
      })

      const reviews = () => getContainer().resolve(PRODUCT_REVIEW_MODULE) as any
      /** Any request, with its status and body whether it worked or not. */
      const call = async (request: Promise<{ status: number; data: any }>) => {
        try {
          const res = await request
          return { ok: true, status: res.status, data: res.data }
        } catch (error: any) {
          return { ok: false, status: error.response?.status as number, data: error.response?.data }
        }
      }
      const hook = (body: Record<string, unknown>) =>
        call(api.post("/webhooks/shiprocket/order-update", body, { headers: { "x-api-key": HOOK } }))
      const emails = (type: string) => storefront.callsTo("/api/wallet/notify").filter((call) => call.body.type === type)
      const whatsapps = (template: string) => storefront.callsTo("/api/whatsapp/send").filter((call) => call.body.template === template)
      const linkOf = async (orderId: string) => {
        const [request] = await reviews().listReviewRequests({ order_id: orderId })
        return { request, token: linkToken(linkSecret(), request.id, request.token_nonce) }
      }
      const optIn = (orderId: string, yes = true) =>
        getContainer().resolve(Modules.ORDER).updateOrders({ id: orderId }, { metadata: { whatsapp_opt_in: yes } })

      /** A delivered order, delivered the way Shiprocket tells us. */
      async function delivered(options: { optIn?: boolean; price?: number } = {}) {
        const placed = await shippedOrder(getContainer(), flow, fx, options.price ? { items: [{ variantId: fx.variantByPrice[options.price] }] } : {})
        if (options.optIn) await optIn(placed.orderId)
        const res = await hook({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "DELIVERED" })
        expect(res.ok).toBe(true)
        return placed
      }

      const session = (token: string) => call(api.post("/store/review-links/session", { token }, { headers: store }))
      const submit = (token: string, list: any[]) => call(api.post("/store/review-links/reviews", { token, reviews: list }, { headers: store }))
      const upload = (token: string, content = PNG) => call(api.post("/store/review-links/photos", { token, content_base64: content }, { headers: store }))
      const productReviews = (sort = "newest") => call(api.get(`/store/product-reviews?handle=probe&sort=${sort}`, { headers: store }))
      const moderate = (body: Record<string, unknown>) => call(api.post("/admin/product-reviews/moderate", body, { headers: admin }))
      const productRating = async () => {
        const { data } = await getContainer().resolve(ContainerRegistrationKeys.QUERY).graph({ entity: "product", fields: ["metadata"], filters: { handle: "probe" } })
        return (data[0] as any).metadata ?? {}
      }

      describe("when Shiprocket says delivered", () => {
        it("emails and WhatsApps the review link once, however often the update repeats", async () => {
          const placed = await delivered({ optIn: true })
          await hook({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "DELIVERED" })
          await sendReviewRequests(getContainer())

          expect(emails("review_request")).toHaveLength(1)
          expect(whatsapps("review_request")).toHaveLength(1)
          const { token } = await linkOf(placed.orderId)
          const mail = emails("review_request")[0].body
          expect(mail).toMatchObject({
            email: placed.email,
            order_number: placed.displayId,
            idempotency_key: `review_request:${placed.orderId}`,
            review_url: `http://127.0.0.1:${STOREFRONT_PORT}/review/${token}`,
          })
          // The tote is not a product to review.
          expect(mail.products.map((p: any) => p.title)).toEqual(["Probe"])
          expect(whatsapps("review_request")[0].body.params.link).toBe(mail.review_url)
          // The link is never stored, only its hash.
          const [request] = await reviews().listReviewRequests({ order_id: placed.orderId })
          expect(JSON.stringify(request)).not.toContain(token)
        })

        it("sends email only to a customer who did not agree to WhatsApp", async () => {
          const placed = await delivered()
          expect(emails("review_request")).toHaveLength(1)
          expect(whatsapps("review_request")).toHaveLength(0)
          const rows = await reviews().listReviewNotifications({ request_id: (await linkOf(placed.orderId)).request.id })
          expect(rows.filter((r: any) => r.channel === "whatsapp").every((r: any) => r.status === "skipped" && r.detail === "no_consent")).toBe(true)
        })

        it("does not ask for a review of a parcel that came back undelivered", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await hook({ order_id: `EYRA-${placed.displayId}`, awb: placed.awb, current_status: "RTO DELIVERED" })
          expect(await reviews().listReviewRequests({ order_id: placed.orderId })).toHaveLength(0)
          expect(emails("review_request")).toHaveLength(0)
        })

        it("retries a failed email later, and never a WhatsApp whose result is unknown", async () => {
          storefront.behaviour.email = "down"
          storefront.behaviour.whatsapp = "down"
          const placed = await delivered({ optIn: true })
          const { request } = await linkOf(placed.orderId)
          let rows = await reviews().listReviewNotifications({ request_id: request.id, stage: "request" })
          expect(rows.map((r: any) => r.status).sort()).toEqual(["failed", "failed"])

          // The retry time comes, and the providers are back.
          await reviews().updateReviewNotifications(rows.map((r: any) => ({ id: r.id, next_attempt_at: new Date(Date.now() - 1000) })))
          storefront.behaviour.email = "ok"
          storefront.behaviour.whatsapp = "ok"
          storefront.calls.length = 0
          await sendReviewRequests(getContainer())
          expect(emails("review_request")).toHaveLength(1)
          expect(whatsapps("review_request")).toHaveLength(1)
          rows = await reviews().listReviewNotifications({ request_id: request.id, stage: "request" })
          expect(rows.every((r: any) => r.status === "sent" && r.attempts === 2)).toBe(true)

          // A run that crashed mid-send left a WhatsApp claimed: it is given up, not sent again.
          const [reminderWa] = await reviews().listReviewNotifications({ request_id: request.id, stage: "reminder", channel: "whatsapp" })
          await reviews().updateReviewNotifications({ id: reminderWa.id, status: "sending", claimed_at: new Date(Date.now() - 3600_000), due_at: new Date(Date.now() - 1000) })
          storefront.calls.length = 0
          await sendReviewRequests(getContainer())
          expect(whatsapps("review_reminder")).toHaveLength(0)
          expect((await reviews().retrieveReviewNotification(reminderWa.id)).status).toBe("gave_up")
        })

        it("opens the request from the scheduled job when the delivery update was missed", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          await (getContainer().resolve("orderDispatch") as any).updateOrderDispatches({ id: placed.dispatchId, delivered_at: new Date() })
          await sendReviewRequests(getContainer())
          expect(await reviews().listReviewRequests({ order_id: placed.orderId })).toHaveLength(1)
          expect(emails("review_request").filter((c) => c.body.order_id === placed.orderId)).toHaveLength(1)
        })
      })

      describe("the review page and its link", () => {
        it("shows the products, takes a review with photos, and is then used up", async () => {
          const placed = await delivered()
          const { token } = await linkOf(placed.orderId)

          const opened = await session(token)
          expect(opened.ok).toBe(true)
          expect(opened.data.session).toMatchObject({ state: "ok", order_number: placed.displayId, suggested_name: "Asha R." })
          expect(opened.data.session.items).toHaveLength(1)
          const line = opened.data.session.items[0]

          const photo = await upload(token)
          expect(photo.ok).toBe(true)
          expect(photo.data.photo.url).toContain("https://eyra-media.s3.ap-south-1.amazonaws.com/")
          expect(s3.objects.size).toBeGreaterThan(0)

          const sent = await submit(token, [
            { line_item_id: line.line_item_id, rating: 2, title: "Clasp is weak", body: "The clasp loosened within a week, though it looks pretty.", photo_ids: [photo.data.photo.id] },
          ])
          expect(sent.status).toBe(201)

          const [review] = await reviews().listProductReviews({ order_id: placed.orderId }, { relations: ["photos"] })
          expect(review).toMatchObject({ status: "pending", rating: 2, verified_purchase: true, source: "link", display_name: "Asha R." })
          expect(review.photos.map((p: any) => p.status)).toEqual(["attached"])

          // Single use: the link cannot be replayed.
          const again = await submit(token, [{ line_item_id: line.line_item_id, rating: 5, body: "Trying to change it with the same link." }])
          expect(again.status).toBe(400)
          expect(JSON.stringify(again.data)).toMatch(/already been used/)
          expect((await session(token)).data.session.state).toBe("used")
          expect(await upload(token)).toMatchObject({ status: 400 })
        })

        it("refuses made-up, expired and not-yet-delivered links", async () => {
          expect((await session("a".repeat(43))).status).toBe(404)
          expect((await session("short")).status).toBe(404)

          const placed = await delivered()
          const { request, token } = await linkOf(placed.orderId)
          await reviews().updateReviewRequests({ id: request.id, token_expires_at: new Date(Date.now() - 1000) })
          expect((await session(token)).data.session.state).toBe("expired")
          const line = (await reviews().listReviewRequests({ id: request.id }))[0]
          expect(line).toBeTruthy()
          const late = await submit(token, [{ line_item_id: "ordli_x", rating: 4, body: "Too late for this link sadly." }])
          expect(late.status).toBe(400)
        })

        it("checks the content and the photos", async () => {
          const placed = await delivered()
          const { token } = await linkOf(placed.orderId)
          const line = (await session(token)).data.session.items[0]

          expect((await submit(token, [{ line_item_id: line.line_item_id, rating: 7, body: "Seven stars is not a thing." }])).status).toBe(400)
          expect((await submit(token, [{ line_item_id: line.line_item_id, rating: 4, body: "ok" }])).status).toBe(400)
          expect((await submit(token, [{ line_item_id: "ordli_not_mine", rating: 4, body: "Not on my order at all." }])).status).toBe(400)
          // Not an image, whatever it is called.
          expect((await upload(token, Buffer.from("<svg onload=alert(1)>").toString("base64"))).status).toBe(400)

          // A photo from another order cannot be borrowed.
          const other = await delivered()
          const otherPhoto = await upload((await linkOf(other.orderId)).token)
          const borrowed = await submit(token, [
            { line_item_id: line.line_item_id, rating: 4, body: "Using someone else's photo here.", photo_ids: [otherPhoto.data.photo.id] },
          ])
          expect(borrowed.status).toBe(400)

          // Flags are for the moderator; a link in the text is flagged, not refused.
          const flagged = await submit(token, [{ line_item_id: line.line_item_id, rating: 5, body: "Great! Also visit www.cheapsilver.com for more." }])
          expect(flagged.status).toBe(201)
          const [review] = await reviews().listProductReviews({ order_id: placed.orderId })
          expect(review.flags.signals).toContain("link")
        })
      })

      describe("reminders", () => {
        it("go once after three days to a customer who has not reviewed, with the same link", async () => {
          const placed = await delivered({ optIn: true })
          const { request, token } = await linkOf(placed.orderId)
          storefront.calls.length = 0

          await sendReviewRequests(getContainer())
          expect(emails("review_reminder")).toHaveLength(0)

          const rows = await reviews().listReviewNotifications({ request_id: request.id, stage: "reminder" })
          expect(rows.every((r: any) => r.status === "scheduled")).toBe(true)
          const dueAt = new Date(rows[0].due_at).getTime() - new Date(request.created_at).getTime()
          expect(Math.round(dueAt / 3600_000)).toBe(72)

          await reviews().updateReviewNotifications(rows.map((r: any) => ({ id: r.id, due_at: new Date(Date.now() - 1000) })))
          await sendReviewRequests(getContainer())
          await sendReviewRequests(getContainer())
          expect(emails("review_reminder")).toHaveLength(1)
          expect(whatsapps("review_reminder")).toHaveLength(1)
          expect(emails("review_reminder")[0].body.review_url).toContain(token)
          expect(emails("review_reminder")[0].body.idempotency_key).toBe(`review_reminder:${placed.orderId}`)
        })

        it("are cancelled when the customer reviews first", async () => {
          const placed = await delivered({ optIn: true })
          const { request, token } = await linkOf(placed.orderId)
          const line = (await session(token)).data.session.items[0]
          expect((await submit(token, [{ line_item_id: line.line_item_id, rating: 5, body: "Beautiful, exactly as pictured." }])).status).toBe(201)

          const rows = await reviews().listReviewNotifications({ request_id: request.id, stage: "reminder" })
          expect(rows.map((r: any) => r.status)).toEqual(["cancelled", "cancelled"])
          await reviews().updateReviewNotifications(rows.map((r: any) => ({ id: r.id, due_at: new Date(Date.now() - 1000) })))
          storefront.calls.length = 0
          await sendReviewRequests(getContainer())
          expect(emails("review_reminder")).toHaveLength(0)
          expect(whatsapps("review_reminder")).toHaveLength(0)
          expect((await reviews().retrieveReviewRequest(request.id)).completed_at).toBeTruthy()
        })
      })

      describe("moderation and the product page", () => {
        it("shows only approved reviews, and rates the product from them alone", async () => {
          const before = (await productReviews()).data
          const a = await delivered()
          const b = await delivered()
          for (const [placed, rating, body] of [
            [a, 5, "Gorgeous and it has not tarnished at all."],
            [b, 1, "Arrived bent and the stone fell out. Very poor."],
          ] as const) {
            const { token } = await linkOf(placed.orderId)
            const line = (await session(token)).data.session.items[0]
            expect((await submit(token, [{ line_item_id: line.line_item_id, rating, body }])).status).toBe(201)
          }
          // Nothing shows while pending.
          expect((await productReviews()).data.summary.count).toBe(before.summary.count)

          const ids = (await reviews().listProductReviews({ order_id: [a.orderId, b.orderId] })).map((r: any) => r.id)
          // A negative review cannot be rejected for being negative.
          expect((await moderate({ ids, action: "reject", reason: "negative", note: "We did not like this review." })).status).toBe(400)
          expect((await moderate({ ids, action: "reject", reason: "spam" })).status).toBe(400)
          // Bulk approval.
          expect((await moderate({ ids, action: "approve" })).ok).toBe(true)

          const after = (await productReviews("lowest")).data
          expect(after.summary.count).toBe(before.summary.count + 2)
          expect(after.reviews[0].rating).toBe(1)
          expect(after.reviews[0]).not.toHaveProperty("customer_email")
          expect(after.reviews[0].verified_purchase).toBe(true)
          expect((await productReviews("highest")).data.reviews[0].rating).toBe(5)
          expect((await productRating()).review_count).toBe(after.summary.count)
          expect((await productRating()).rating).toBe(after.summary.average)

          // A rejection with a policy ground takes it off the page and out of the rating.
          const reject = await moderate({ ids: [ids[0]], action: "reject", reason: "off_topic", note: "Talks about delivery, not the product." })
          expect(reject.ok).toBe(true)
          expect((await productReviews()).data.summary.count).toBe(after.summary.count - 1)
          expect((await productRating()).review_count).toBe(after.summary.count - 1)
        })

        it("lists reviews for the admin with the order and customer, and filters them", async () => {
          const placed = await delivered()
          const { token } = await linkOf(placed.orderId)
          const line = (await session(token)).data.session.items[0]
          await submit(token, [{ line_item_id: line.line_item_id, rating: 3, body: "Decent for the price, smaller than expected." }])

          const listed = await call(api.get(`/admin/product-reviews?status=pending&order_id=${placed.orderId}`, { headers: admin }))
          expect(listed.ok).toBe(true)
          expect(listed.data.reviews[0]).toMatchObject({ customer_email: placed.email, order_display_id: placed.displayId, product_title: "Probe", status: "pending" })
          expect(listed.data.counts.pending).toBeGreaterThan(0)
          expect((await call(api.get("/admin/product-reviews", {}))).status).toBe(401)

          const status = await call(api.get(`/admin/orders/${placed.orderId}/review-request`, { headers: admin }))
          expect(status.data.review_request.notifications).toHaveLength(4)
          expect(status.data.review_request).not.toHaveProperty("token_hash")
          expect(status.data.reviews).toHaveLength(1)
        })
      })

      describe("the signed-in order page", () => {
        it("edits the customer's review, which goes back to be checked, and never makes a second one", async () => {
          const placed = await delivered()
          const { token } = await linkOf(placed.orderId)
          const line = (await session(token)).data.session.items[0]
          await submit(token, [{ line_item_id: line.line_item_id, rating: 4, body: "Nice ring, comfortable to wear." }])
          const [review] = await reviews().listProductReviews({ order_id: placed.orderId })
          await moderate({ ids: [review.id], action: "approve" })

          const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [placed.orderId] }, { select: ["customer_id"] })
          const customerId = (order as any).customer_id
          const mine = await call(api.get(`/admin/product-reviews/customer?customer_id=${customerId}&order_id=${placed.orderId}`, { headers: admin }))
          expect(mine.data.session.items[0].review).toMatchObject({ rating: 4, status: "approved" })

          const photo = await call(
            api.post("/admin/product-reviews/customer/photos", { customer_id: customerId, order_id: placed.orderId, content_base64: PNG }, { headers: admin })
          )
          expect(photo.status).toBe(201)
          const edited = await call(
            api.post(
              "/admin/product-reviews/customer",
              {
                customer_id: customerId,
                order_id: placed.orderId,
                reviews: [{ line_item_id: line.line_item_id, rating: 3, body: "Update: the shine faded after a month.", photo_ids: [photo.data.photo.id] }],
              },
              { headers: admin }
            )
          )
          expect(edited.status).toBe(201)
          const all = await reviews().listProductReviews({ customer_key: review.customer_key }, { relations: ["photos"] })
          expect(all).toHaveLength(1)
          expect(all[0]).toMatchObject({ id: review.id, rating: 3, status: "pending" })
          expect(all[0].edited_at).toBeTruthy()
          expect(all[0].photos).toHaveLength(1)

          // Someone else's order is not found.
          const stranger = await call(api.get(`/admin/product-reviews/customer?customer_id=cus_stranger&order_id=${placed.orderId}`, { headers: admin }))
          expect(stranger.status).toBe(404)
        })

        it("refuses an order that has not been delivered", async () => {
          const placed = await shippedOrder(getContainer(), flow, fx)
          const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [placed.orderId] }, { select: ["customer_id", "items.id"], relations: ["items"] })
          const res = await call(
            api.post(
              "/admin/product-reviews/customer",
              { customer_id: (order as any).customer_id, order_id: placed.orderId, reviews: [{ line_item_id: (order as any).items[0].id, rating: 5, body: "Have not received it yet but sure." }] },
              { headers: admin }
            )
          )
          expect(res.status).toBe(400)
          expect(JSON.stringify(res.data)).toMatch(/once it has been delivered/)
        })
      })

      describe("WhatsApp consent at checkout", () => {
        it("is kept on the cart and carried to the order", async () => {
          const who = await flow.customer()
          const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
          const set = await call(api.post(`/store/carts/${cartId}/whatsapp-consent`, { opt_in: true }, { headers: store }))
          expect(set.data).toEqual({ whatsapp_opt_in: true })
          await flow.reconcile(cartId)
          await flow.setMode(cartId, "cod")
          const orderId = await flow.placeCod(cartId, who.email)
          const [order] = await getContainer().resolve(Modules.ORDER).listOrders({ id: [orderId] }, { select: ["metadata"] })
          expect((order as any).metadata.whatsapp_opt_in).toBe(true)
          expect((await call(api.post(`/store/carts/${cartId}/whatsapp-consent`, { opt_in: "yes" }, { headers: store }))).status).toBe(400)
        })
      })

      describe("admin review link", () => {
        it("issues a fresh link and retires the old one", async () => {
          const placed = await delivered()
          const { token: old } = await linkOf(placed.orderId)
          const fresh = await call(api.post(`/admin/orders/${placed.orderId}/review-request/link`, {}, { headers: admin }))
          expect(fresh.data.url).toMatch(/\/review\/[A-Za-z0-9_-]{43}$/)
          expect((await session(old)).status).toBe(404)
          const newToken = fresh.data.url.split("/review/")[1]
          expect((await session(newToken)).data.session.state).toBe("ok")
        })
      })
    })
  },
})
