import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys as Keys, Modules } from "@medusajs/framework/utils"
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import sendAnalyticsBacklog from "../../src/jobs/send-analytics-backlog"
import { sendOrderEvent } from "../../src/utils/analytics-orders"
import { eventUuid } from "../../src/utils/posthog"
import { checkoutFlow } from "./helpers/checkout-flow"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

process.env.POSTHOG_PROJECT_TOKEN = "phc_integrationtesttoken"
process.env.POSTHOG_HOST = "https://eu.i.posthog.com"
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

// Server-side analytics: a real order through Medusa sends order_placed (and
// order_cancelled) to PostHog once, under the customer's Medusa id, with no
// personal data. PostHog itself is intercepted here; nothing leaves the machine.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("PostHog order events", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      const sent: Record<string, any>[] = []
      let fetchSpy: jest.SpyInstance
      let posthogDown = false

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        const realFetch = global.fetch
        fetchSpy = jest.spyOn(global, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.startsWith("https://eu.i.posthog.com/")) {
            if (posthogDown) return new Response("unavailable", { status: 503 })
            sent.push(JSON.parse(String(init?.body)))
            return new Response("{}", { status: 200 })
          }
          return realFetch(input, init)
        }) as typeof fetch)
      })

      afterAll(() => fetchSpy.mockRestore())

      const eventsFor = (orderId: string) => sent.filter((e) => e.properties?.order_id === orderId)
      const waitFor = async (check: () => boolean, ms = 15000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (check()) return true
          await wait(200)
        }
        return false
      }

      const customers = () => getContainer().resolve(Modules.CUSTOMER)
      /** What the storefront records when the customer accepts, declines or withdraws. */
      const setConsent = async (customerId: string, status: "granted" | "denied", at = new Date(Date.now() - 60000)) =>
        customers().updateCustomers(customerId, { metadata: { analytics_consent: { status, at: at.toISOString(), version: 1 } } })
      /** Makes an order look older than the backlog's grace period. */
      const age = (orderId: string) =>
        getContainer().resolve(Modules.ORDER).updateOrders({ id: orderId }, { created_at: new Date(Date.now() - 30 * 60000) } as any)
      const placeOrder = async (who: { email: string }) => {
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.setMode(cartId, "cod")
        return flow.placeCod(cartId, who.email)
      }
      const customerOf = async (orderId: string) => {
        const { data } = await getContainer().resolve(Keys.QUERY).graph({ entity: "order", fields: ["customer_id"], filters: { id: orderId } })
        return (data[0] as any).customer_id as string
      }

      it("a placed and then cancelled order is sent once each, under the customer id, without personal data", async () => {
        const who = await flow.customer()
        // The profile's other metadata stays when the consent is recorded.
        await customers().updateCustomers(who.id, { metadata: { favourite: "anklets" } })
        await setConsent(who.id, "granted")
        const [profile] = await customers().listCustomers({ id: who.id }, { select: ["id", "metadata"] })
        expect(profile.metadata).toMatchObject({ favourite: "anklets", analytics_consent: { status: "granted", version: 1 } })
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)

        expect(await waitFor(() => eventsFor(orderId).some((e) => e.event === "order_placed"))).toBe(true)
        const { data } = await getContainer()
          .resolve(Keys.QUERY)
          .graph({ entity: "order", fields: ["customer_id"], filters: { id: orderId } })
        const placed = eventsFor(orderId).find((e) => e.event === "order_placed")!
        expect(placed).toMatchObject({
          api_key: "phc_integrationtesttoken",
          distinct_id: (data[0] as any).customer_id,
          uuid: eventUuid(`order_placed:${orderId}`),
          properties: { order_id: orderId, value: 2000 + 99, currency: "INR", item_count: 1, payment_method: "cod", has_discount: false, wallet_credit_used: false },
        })
        expect(placed.distinct_id).toMatch(/^cus_/)
        // Nothing personal: not the email, the name, the phone or the address.
        const text = JSON.stringify(placed)
        for (const personal of [who.email, "Asha", "Rao", "9999999999", "Lake Road", "411001"]) expect(text).not.toContain(personal)

        await cancelOrderWorkflow(getContainer()).run({ input: { order_id: orderId } })
        expect(await waitFor(() => eventsFor(orderId).some((e) => e.event === "order_cancelled"))).toBe(true)
        await wait(2000)
        expect(eventsFor(orderId).map((e) => e.event).sort()).toEqual(["order_cancelled", "order_placed"])

        // Medusa announcing the order again (the payment repair job does) sends nothing more.
        await getContainer().resolve(Modules.EVENT_BUS).emit({ name: "order.placed", data: { id: orderId } })
        expect(await sendOrderEvent(getContainer(), orderId, "order_placed")).toBe("already_sent")
        await wait(2000)
        expect(eventsFor(orderId)).toHaveLength(2)
      })

      it("an event PostHog did not take is sent later by the backlog job, once", async () => {
        const who = await flow.customer()
        // Given well before the order, which the test later backdates past the grace period.
        await setConsent(who.id, "granted", new Date(Date.now() - 2 * 60 * 60000))
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.setMode(cartId, "cod")
        posthogDown = true
        const orderId = await flow.placeCod(cartId, who.email)
        await wait(3000)
        posthogDown = false
        expect(eventsFor(orderId)).toHaveLength(0)

        // Past the grace period, the backlog finds it unsent and sends it; other metadata is kept.
        const orders = getContainer().resolve(Modules.ORDER)
        const [before] = await orders.listOrders({ id: orderId }, { select: ["id", "metadata"] })
        await orders.updateOrders({ id: orderId }, { created_at: new Date(Date.now() - 30 * 60000) } as any)
        await sendAnalyticsBacklog(getContainer())
        expect(eventsFor(orderId).map((e) => e.event)).toEqual(["order_placed"])
        const [after] = await orders.listOrders({ id: orderId }, { select: ["id", "metadata"] })
        expect(after.metadata).toMatchObject({ ...(before.metadata ?? {}), analytics_placed_sent_at: expect.any(String) })

        await sendAnalyticsBacklog(getContainer())
        expect(eventsFor(orderId)).toHaveLength(1)
      })

      describe("consent", () => {
        it("missing: the order is never sent, not even by the backlog", async () => {
          const who = await flow.customer()
          const orderId = await placeOrder(who)
          expect(await customerOf(orderId)).toBe(who.id)
          expect(await sendOrderEvent(getContainer(), orderId, "order_placed")).toBe("no_consent")
          await age(orderId)
          await sendAnalyticsBacklog(getContainer())
          await wait(1500)
          expect(eventsFor(orderId)).toHaveLength(0)
        })

        it("declined: the order is never sent", async () => {
          const who = await flow.customer()
          await setConsent(who.id, "denied")
          const orderId = await placeOrder(who)
          await age(orderId)
          await sendAnalyticsBacklog(getContainer())
          await wait(1500)
          expect(eventsFor(orderId)).toHaveLength(0)
        })

        it("withdrawn after the order: what was still waiting is not sent", async () => {
          const who = await flow.customer()
          await setConsent(who.id, "granted")
          posthogDown = true
          const orderId = await placeOrder(who)
          await wait(3000)
          posthogDown = false
          expect(eventsFor(orderId)).toHaveLength(0)
          await setConsent(who.id, "denied", new Date())
          await age(orderId)
          await sendAnalyticsBacklog(getContainer())
          expect(await sendOrderEvent(getContainer(), orderId, "order_placed")).toBe("no_consent")
          expect(eventsFor(orderId)).toHaveLength(0)
        })

        it("given after the order: not retroactive, the earlier order is not sent", async () => {
          const who = await flow.customer()
          const orderId = await placeOrder(who)
          await wait(1500)
          await setConsent(who.id, "granted", new Date())
          await age(orderId)
          await sendAnalyticsBacklog(getContainer())
          expect(eventsFor(orderId)).toHaveLength(0)
        })

        it("withdrawn before a cancellation: the cancellation is not sent", async () => {
          const who = await flow.customer()
          await setConsent(who.id, "granted")
          const orderId = await placeOrder(who)
          expect(await waitFor(() => eventsFor(orderId).some((e) => e.event === "order_placed"))).toBe(true)
          await setConsent(who.id, "denied", new Date())
          await cancelOrderWorkflow(getContainer()).run({ input: { order_id: orderId } })
          await wait(2000)
          expect(eventsFor(orderId).map((e) => e.event)).toEqual(["order_placed"])
        })
      })
    })
  },
})
