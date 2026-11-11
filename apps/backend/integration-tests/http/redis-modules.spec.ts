import crypto from "node:crypto"
import { execSync } from "node:child_process"
import http from "node:http"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import { createInventoryLevelsWorkflow, createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { repairOrderReservationsWorkflow } from "../../src/workflows/repair-order-reservations"
import { razorpayWebhookSecret } from "../../src/modules/payment-snapshot/webhook-guard"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

// Opt-in: boots the backend with the Redis event bus, workflow engine and
// locking, as production should run. Needs a throwaway Redis, for example:
//   docker run -d --name eyra-redis-test -p 127.0.0.1:16379:6379 redis:7-alpine
//   REDIS_TEST_URL=redis://127.0.0.1:16379 REDIS_TEST_CONTAINER=eyra-redis-test npm run test:integration:http -- redis-modules
// REDIS_TEST_CONTAINER lets the test pause and resume Redis to cut the connection.

const REDIS_TEST_URL = process.env.REDIS_TEST_URL
const CONTAINER = process.env.REDIS_TEST_CONTAINER
if (REDIS_TEST_URL) process.env.REDIS_URL = REDIS_TEST_URL
// Start from an empty Redis, before the app boots: queued events from an earlier
// run would otherwise be picked up (which is the durability being tested) and
// processed against this run's empty database.
if (REDIS_TEST_URL && CONTAINER) execSync(`docker exec ${CONTAINER} redis-cli FLUSHALL`)

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
// Redis alerts go to this stand-in storefront.
process.env.STOREFRONT_REVALIDATE_URL = "http://127.0.0.1:19437/api/revalidate"
process.env.STOREFRONT_REVALIDATE_SECRET = "redis-secret"
const alerts: Record<string, unknown>[] = []
const alertServer = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    if (req.url === "/api/ops/notify") alerts.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"))
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ received: true, sent: true }))
  })
})
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const redisCli = (command: string) => execSync(`docker exec ${CONTAINER} redis-cli ${command}`).toString().trim()

if (!REDIS_TEST_URL) {
  describe.skip("with Redis-backed Medusa modules (set REDIS_TEST_URL to run)", () => {
    it("needs a Redis server", () => undefined)
  })
} else medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("with Redis-backed Medusa modules", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        await new Promise<void>((done) => alertServer.listen(19437, "127.0.0.1", () => done()))
        razorpay = await startFakeRazorpay(19434)
        razorpay.attach(getContainer())
      })

      afterAll(async () => {
        if (CONTAINER) execSync(`docker unpause ${CONTAINER} || true`)
        await razorpay.close()
        await new Promise((done) => alertServer.close(() => done(undefined)))
        delete process.env.REDIS_URL
      })

      const openPayment = async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.must(
          api.post(
            `/store/carts/${cartId}`,
            {
              email: who.email,
              shipping_address: {
                first_name: "A", last_name: "R", phone: "9999999999", address_1: "1", city: "Pune",
                province: "Maharashtra", postal_code: "411001", country_code: "in",
              },
            },
            { headers: flow.headers }
          )
        )
        await flow.setMode(cartId, "prepaid")
        const opened = await flow.must(api.post(`/store/carts/${cartId}/razorpay-session`, {}, { headers: flow.headers }))
        return { cartId, razorpayOrderId: opened.razorpay_order_id as string }
      }

      const hook = async (payment: object) => {
        const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { ...payment, notes: {} } } } })
        const signature = crypto.createHmac("sha256", razorpayWebhookSecret()).update(body).digest("hex")
        try {
          const res = await api.post("/hooks/payment/razorpay_razorpay", body, {
            headers: { "content-type": "application/json", "x-razorpay-signature": signature },
            transformRequest: [(d: unknown) => d],
          })
          return res.status
        } catch (error: any) {
          return error.response?.status as number
        }
      }

      const orderCount = async (cartId: string) => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
        return data.length
      }

      const waitFor = async (check: () => Promise<boolean>, ms = 30000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (await check()) return true
          await wait(500)
        }
        return false
      }

      // One test on purpose: from the second test on, the test runner reloads
      // every module into a copied container, which with Redis modules opens and
      // closes extra BullMQ connections and reports a spurious "Connection is
      // closed". Production boots the modules once per process.
      it("runs on Redis, keeps webhook events in Redis, and recovers from a Redis outage", async () => {
        const container = getContainer()
        expect(container.resolve(Modules.EVENT_BUS).constructor.name).toMatch(/Redis/i)
        expect(redisCli("PING")).toBe("PONG")
        expect(redisCli("KEYS 'bull:medusa-workflows:*'").length).toBeGreaterThan(0)
        expect(redisCli("KEYS 'RedisEventBusService:events-queue:*'").length).toBeGreaterThan(0)

        // A received webhook waits in Redis as a delayed job (processed about 5 s later).
        const first = await openPayment()
        const firstPayment = razorpay.pay(first.razorpayOrderId)
        expect(await hook(firstPayment)).toBe(200)
        expect(Number(redisCli("ZCARD RedisEventBusService:events-queue:delayed"))).toBeGreaterThan(0)
        expect(await waitFor(async () => (await orderCount(first.cartId)) === 1)).toBe(true)

        if (!CONTAINER) return
        // Redis goes away: payment routes answer 503 at once instead of hanging.
        const second = await openPayment()
        const secondPayment = razorpay.pay(second.razorpayOrderId)
        execSync(`docker pause ${CONTAINER}`)
        let started = Date.now()
        expect(await hook(secondPayment)).toBe(503)
        expect(Date.now() - started).toBeLessThan(3000)
        started = Date.now()
        const refused = await flow.attempt(api.post(`/store/carts/${second.cartId}/complete`, {}, { headers: flow.headers }))
        expect(refused).toMatchObject({ ok: false, status: 503 })
        expect(Date.now() - started).toBeLessThan(3000)
        const opening = await flow.attempt(api.post(`/store/carts/${second.cartId}/razorpay-session`, {}, { headers: flow.headers }))
        expect(opening).toMatchObject({ ok: false, status: 503 })
        expect(await orderCount(second.cartId)).toBe(0)

        // Down for more than 30 s: the team is told, once.
        await wait(33000)
        execSync(`docker unpause ${CONTAINER}`)
        await wait(5000)
        expect(alerts.filter((a) => a.type === "redis_down")).toHaveLength(1)
        expect(alerts.filter((a) => a.type === "redis_recovered")).toHaveLength(1)

        // Redis is back: Razorpay's redelivery is processed and the order is placed once.
        expect(await hook(secondPayment)).toBe(200)
        expect(await waitFor(async () => (await orderCount(second.cartId)) === 1, 45000)).toBe(true)
        const done = await flow.attempt(api.post(`/store/carts/${second.cartId}/complete`, {}, { headers: flow.headers }))
        expect(done.ok && done.data.type).toBe("order")
        expect(await orderCount(second.cartId)).toBe(1)
        expect(razorpay.refunds).toHaveLength(0)

        // With Redis locking: two stock repairs racing for the last unit.
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const inventory = getContainer().resolve(Modules.INVENTORY)
        const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query.graph({ entity: "stock_location", fields: ["id"] })
        const sku = `RACE-${Date.now()}`
        const { result: [product] } = await createProductsWorkflow(getContainer()).run({
          input: {
            products: [{
              title: "Race probe", handle: sku.toLowerCase(), status: ProductStatus.PUBLISHED,
              shipping_profile_id: (profiles[0] as any).id, sales_channels: [{ id: fx.salesChannelId }],
              options: [{ title: "Set", values: ["Single"] }],
              variants: [{ title: "Single", sku, manage_inventory: true, options: { Set: "Single" }, prices: [{ amount: 2000, currency_code: "inr" }] }],
            }],
          } as never,
        })
        const { data: items } = await query.graph({ entity: "inventory_item", fields: ["id"], filters: { sku } })
        const itemId = (items[0] as any).id
        await createInventoryLevelsWorkflow(getContainer()).run({ input: { inventory_levels: [{ location_id: (locations[0] as any).id, inventory_item_id: itemId, stocked_quantity: 2 }] } })
        const raceVariant = (product as any).variants[0].id
        const raceOrders: string[] = []
        for (let i = 0; i < 2; i++) {
          const who = await flow.customer()
          const cartId = await flow.cart(who.email, [{ variantId: raceVariant }])
          await flow.setMode(cartId, "cod")
          raceOrders.push(await flow.placeCod(cartId, who.email))
        }
        const { data: lines } = await query.graph({ entity: "order", fields: ["items.id"], filters: { id: raceOrders } })
        await inventory.deleteReservationItemsByLineItem((lines as any[]).flatMap((o) => o.items.map((i: any) => i.id)))
        const [level] = await inventory.listInventoryLevels({ inventory_item_id: itemId })
        await inventory.updateInventoryLevels([{ inventory_item_id: itemId, location_id: level.location_id, stocked_quantity: Number(level.reserved_quantity) + 1 }])
        const results = await Promise.all(raceOrders.map((id) => repairOrderReservationsWorkflow(getContainer()).run({ input: { order_id: id } })))
        expect(results.reduce((n, r) => n + r.result.created, 0)).toBe(1)
        const [after] = await inventory.listInventoryLevels({ inventory_item_id: itemId })
        expect(Number(after.reserved_quantity)).toBeLessThanOrEqual(Number(after.stocked_quantity))
      })
    })
  },
})
