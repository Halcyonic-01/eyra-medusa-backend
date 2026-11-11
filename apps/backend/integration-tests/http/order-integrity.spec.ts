import http from "node:http"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules, ProductStatus, generateJwtToken } from "@medusajs/framework/utils"
import {
  acquireLockStep,
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createOrderPaymentCollectionWorkflow,
  createProductVariantsWorkflow,
  createProductsWorkflow,
  markPaymentCollectionAsPaid,
  releaseLockStep,
  updateInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import recoverOrderIntegrity from "../../src/jobs/recover-order-integrity"
import { CHECKOUT_MARKER } from "../../src/modules/order-dispatch/order-integrity"
import { loadPaymentStanding } from "../../src/modules/order-dispatch/payment-standing"
import { WALLET_MODULE } from "../../src/modules/wallet"
import { redemptionReference } from "../../src/modules/wallet/utils"
import { markConfirmationEmailSent } from "../../src/utils/order-confirmation"
import { applyWalletToCartWorkflow } from "../../src/workflows/apply-wallet-to-cart"
import { createOrderDispatchWorkflow } from "../../src/workflows/create-order-dispatch"
import { dispatchOrderWorkflow } from "../../src/workflows/dispatch-order"
import { issueWalletCreditWorkflow } from "../../src/workflows/issue-wallet-credit"
import { redeemWalletForOrderWorkflow } from "../../src/workflows/redeem-wallet-for-order"
import { voidOrphanOrderWorkflow } from "../../src/workflows/void-orphan-order"
import { repairOrderReservationsWorkflow } from "../../src/workflows/repair-order-reservations"
import { checkoutFlow } from "./helpers/checkout-flow"
import { startFakeRazorpay } from "./helpers/fake-razorpay"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

const STOREFRONT_PORT = 19436
process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.STOREFRONT_REVALIDATE_URL = `http://127.0.0.1:${STOREFRONT_PORT}/api/revalidate`
process.env.STOREFRONT_REVALIDATE_SECRET = "integrity-secret"
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(300000)

type EmailMode = "send" | "fail" | "skip"

/** Stand-in storefront: records alerts, and answers the email route as the real one would. */
function startFakeStorefront(onSend: (orderId: string) => Promise<void>) {
  const alerts: Record<string, any>[] = []
  const emailCalls: string[] = []
  const behaviour = { email: "send" as EmailMode }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      const json = (status: number, payload: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload))
      if (req.headers["x-revalidate-secret"] !== "integrity-secret") return json(401, {})
      if (req.url === "/api/ops/notify") {
        alerts.push(body)
        return json(200, { received: true, sent: true })
      }
      if (req.url === "/api/orders/confirmation-email") {
        emailCalls.push(body.order_id)
        if (behaviour.email === "fail") return json(502, { result: "failed" })
        if (behaviour.email === "skip") return json(200, { result: "skipped" })
        await onSend(body.order_id)
        return json(200, { result: "sent" })
      }
      return json(404, {})
    })
  })
  return new Promise<{ alerts: typeof alerts; emailCalls: string[]; behaviour: typeof behaviour; close: () => Promise<void> }>((resolve) =>
    server.listen(STOREFRONT_PORT, "127.0.0.1", () =>
      resolve({ alerts, emailCalls, behaviour, close: () => new Promise((done) => server.close(() => done())) })
    )
  )
}

// Holds the same lock Medusa's cart completion takes, to show voiding waits for it.
const holdCartLock = createWorkflow("test-hold-cart-lock", function (input: { key: string }) {
  acquireLockStep({ key: input.key, timeout: 5, ttl: 30 })
  return new WorkflowResponse(true)
})
const releaseCartLock = createWorkflow("test-release-cart-lock", function (input: { key: string }) {
  releaseLockStep({ key: input.key })
  return new WorkflowResponse(true)
})

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("order integrity recovery", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let razorpay: Awaited<ReturnType<typeof startFakeRazorpay>>
      let storefront: Awaited<ReturnType<typeof startFakeStorefront>>
      let apiKey: Record<string, string>
      let staff: Record<string, string>
      let staffId: string
      /** A stock-tracked anklet: Single, and Pair taking two of the Single's stock (as the real anklets do). */
      let single: string
      let pair: string
      let ankletItem: string

      const container = () => getContainer()
      const query = () => container().resolve(ContainerRegistrationKeys.QUERY)
      const pg = () => container().resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
      const address = {
        first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
        city: "Pune", province: "Maharashtra", postal_code: "411001", country_code: "in",
      }

      beforeAll(async () => {
        fx = await seedLaunchFixtures(container())
        flow = checkoutFlow(api, getContainer, fx)
        razorpay = await startFakeRazorpay(19435)
        razorpay.attach(container())
        storefront = await startFakeStorefront((orderId) => markConfirmationEmailSent(pg(), orderId))

        const { result: [key] } = await createApiKeysWorkflow(container()).run({
          input: { api_keys: [{ title: "storefront", type: "secret", created_by: "" }] },
        })
        apiKey = { Authorization: `Basic ${key.token}` }

        const user = await container().resolve(Modules.USER).createUsers({ email: "staff@eyra.test" })
        const identity = await container().resolve(Modules.AUTH).createAuthIdentities({
          provider_identities: [{ provider: "emailpass", entity_id: "staff@eyra.test" }],
          app_metadata: { user_id: user.id },
        })
        const config = container().resolve("configModule") as any
        const token = generateJwtToken(
          { actor_id: user.id, actor_type: "user", auth_identity_id: identity.id, app_metadata: { user_id: user.id } },
          { secret: config.projectConfig.http.jwtSecret, expiresIn: "1d" }
        )
        staff = { Authorization: `Bearer ${token}` }
        staffId = user.id

        const { data: profiles } = await query().graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query().graph({ entity: "stock_location", fields: ["id"] })
        const sku = `ANKLET-${Date.now()}`
        const { result: [product] } = await createProductsWorkflow(container()).run({
          input: {
            products: [
              {
                title: "Anklet probe",
                handle: `anklet-probe-${Date.now()}`,
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: (profiles[0] as any).id,
                sales_channels: [{ id: fx.salesChannelId }],
                options: [{ title: "Set", values: ["Single", "Pair"] }],
                variants: [{ title: "Single", sku, manage_inventory: true, options: { Set: "Single" }, prices: [{ amount: 2000, currency_code: "inr" }] }],
              },
            ],
          } as never,
        })
        const { data: items } = await query().graph({ entity: "inventory_item", fields: ["id"], filters: { sku } })
        ankletItem = (items[0] as any).id
        await createInventoryLevelsWorkflow(container()).run({
          input: { inventory_levels: [{ location_id: (locations[0] as any).id, inventory_item_id: ankletItem, stocked_quantity: 50 }] },
        })
        single = (product as any).variants[0].id
        const { result: pairs } = await createProductVariantsWorkflow(container()).run({
          input: {
            product_variants: [
              {
                product_id: (product as any).id,
                title: "Pair",
                sku: `${sku}-PAIR`,
                manage_inventory: true,
                options: { Set: "Pair" },
                prices: [{ amount: 3600, currency_code: "inr" }],
                inventory_items: [{ inventory_item_id: ankletItem, required_quantity: 2 }],
              },
            ],
          } as never,
        })
        pair = (pairs as any)[0].id
      })

      afterAll(async () => {
        await razorpay.close()
        await storefront.close()
      })

      beforeEach(() => {
        storefront.alerts.length = 0
        storefront.emailCalls.length = 0
        storefront.behaviour.email = "send"
      })

      const backdate = (orderId: string, minutes: number) =>
        pg().raw(`UPDATE "order" SET created_at = now() - (?::int * interval '1 minute') WHERE id = ?`, [minutes, orderId])

      const metadataOf = async (orderId: string) => {
        const { data } = await query().graph({ entity: "order", fields: ["status", "metadata"], filters: { id: orderId } })
        return data[0] as any
      }

      /** A COD checkout through the real routes, completed. */
      const codOrder = async (variantId = fx.variantByPrice[2000], quantity = 1) => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId, quantity }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)
        return { cartId, orderId, email: who.email, customerId: who.id }
      }

      /** What a crash right after Medusa writes the order row leaves, for a marked cart. */
      const leftoverOrder = async (cartId: string | null, email: string) => {
        const created = await container().resolve(Modules.ORDER).createOrders({
          region_id: fx.regionId,
          sales_channel_id: fx.salesChannelId,
          currency_code: "inr",
          email,
          status: "pending",
          metadata: cartId ? { [CHECKOUT_MARKER]: cartId } : {},
          items: [{ title: "Probe", variant_id: fx.variantByPrice[2000], quantity: 1, unit_price: 2000 }],
        } as never)
        return (created as unknown as { id: string; items: { id: string }[] })
      }

      const reservationsFor = async (orderId: string) => {
        const { data } = await query().graph({ entity: "order", fields: ["items.id"], filters: { id: orderId } })
        const ids = ((data[0] as any).items ?? []).map((i: any) => i.id)
        const rows = await container().resolve(Modules.INVENTORY).listReservationItems({ line_item_id: ids })
        return rows.map((r) => ({ line_item_id: r.line_item_id, inventory_item_id: r.inventory_item_id, quantity: Number(r.quantity) }))
      }

      // ── Checkout marker ─────────────────────────────────────

      it("every checkout order carries its cart's id, copied by Medusa from the cart", async () => {
        const { cartId, orderId } = await codOrder()
        expect((await metadataOf(orderId)).metadata[CHECKOUT_MARKER]).toBe(cartId)
      })

      // ── Orphan orders ────────────────────────────────────────

      it("voids a checkout leftover without a refund, wallet change or cancel event, and frees its stock", async () => {
        const real = await codOrder(single)
        const orphan = await leftoverOrder(real.cartId, real.email)
        // A crash in the middle of Medusa's parallel step can leave a reservation on the leftover.
        const realLine = (await reservationsFor(real.orderId))[0]
        const [realReservation] = await container().resolve(Modules.INVENTORY).listReservationItems({ line_item_id: [realLine.line_item_id as string] })
        await container().resolve(Modules.INVENTORY).createReservationItems([
          { line_item_id: orphan.items[0].id, inventory_item_id: realReservation.inventory_item_id, location_id: realReservation.location_id, quantity: 1 },
        ])
        await createOrderDispatchWorkflow(container()).run({ input: { order_id: orphan.id, window_minutes: 0 } })
        await backdate(orphan.id, 20)
        expect(await reservationsFor(orphan.id)).toHaveLength(1)

        await recoverOrderIntegrity(container())

        const voided = await metadataOf(orphan.id)
        expect(voided.status).toBe("canceled")
        expect(voided.metadata.orphan_voided_at).toBeTruthy()
        expect(await reservationsFor(orphan.id)).toHaveLength(0)
        const { data: dispatch } = await query().graph({ entity: "order_dispatch", fields: ["state"], filters: { order_id: orphan.id } })
        expect((dispatch[0] as any).state).toBe("cancelled")
        expect(storefront.alerts.map((a) => a.type)).toContain("order_orphan_voided")

        // The customer's real order is untouched, and nothing was refunded.
        expect((await metadataOf(real.orderId)).status).not.toBe("canceled")
        expect(await reservationsFor(real.orderId)).toHaveLength(1)
        expect(razorpay.refunds).toHaveLength(0)

        // Running again changes nothing.
        await recoverOrderIntegrity(container())
        expect((await metadataOf(orphan.id)).status).toBe("canceled")
      })

      it("never voids an order made in the admin, a recent leftover, or the cart's real order", async () => {
        const real = await codOrder()
        const admin = await leftoverOrder(null, real.email)
        const recent = await leftoverOrder(real.cartId, real.email)
        await backdate(admin.id, 60)
        await backdate(real.orderId, 60)

        expect((await voidOrphanOrderWorkflow(container()).run({ input: { order_id: admin.id } })).result).toMatchObject({ voided: false, reason: "not_from_checkout" })
        expect((await voidOrphanOrderWorkflow(container()).run({ input: { order_id: recent.id } })).result).toMatchObject({ voided: false, reason: "too_recent" })
        expect((await voidOrphanOrderWorkflow(container()).run({ input: { order_id: real.orderId } })).result).toMatchObject({ voided: false, reason: "linked_to_cart" })
        expect((await metadataOf(admin.id)).status).not.toBe("canceled")
        expect((await metadataOf(real.orderId)).status).not.toBe("canceled")
      })

      it("never voids a leftover that has a payment recorded", async () => {
        const real = await codOrder()
        const orphan = await leftoverOrder(real.cartId, real.email)
        const { result: collections } = await createOrderPaymentCollectionWorkflow(container()).run({ input: { order_id: orphan.id, amount: 2000 } })
        await markPaymentCollectionAsPaid(container()).run({ input: { order_id: orphan.id, payment_collection_id: (collections as any)[0].id } })
        await backdate(orphan.id, 20)
        expect((await voidOrphanOrderWorkflow(container()).run({ input: { order_id: orphan.id } })).result).toMatchObject({ voided: false, reason: "has_payment" })
      })

      it("waits for a completion of the same cart that is still running", async () => {
        const real = await codOrder()
        const orphan = await leftoverOrder(real.cartId, real.email)
        await backdate(orphan.id, 20)
        await holdCartLock(container()).run({ input: { key: real.cartId } })
        const started = Date.now()
        const voiding = voidOrphanOrderWorkflow(container()).run({ input: { order_id: orphan.id } })
        await new Promise((r) => setTimeout(r, 2000))
        expect((await metadataOf(orphan.id)).status).not.toBe("canceled")
        await releaseCartLock(container()).run({ input: { key: real.cartId } })
        const { result } = await voiding
        expect(result.voided).toBe(true)
        expect(Date.now() - started).toBeGreaterThanOrEqual(2000)
      })

      it("an order linked to its cart but missing its payment link is held, not treated as owing nothing", async () => {
        const { orderId } = await codOrder()
        await pg().raw(`UPDATE order_payment_collection SET deleted_at = now() WHERE order_id = ?`, [orderId])
        const standing = await loadPaymentStanding(container(), orderId)
        expect(standing).toMatchObject({ ok: false, reason: "no_payment_record" })
      })

      // ── Stock reservations ───────────────────────────────────

      it("restores the reservations a crash left out, exactly once", async () => {
        const { orderId } = await codOrder(single)
        const before = await reservationsFor(orderId)
        expect(before).toHaveLength(1)
        await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem(before.map((r) => r.line_item_id as string))
        await backdate(orderId, 10)

        await recoverOrderIntegrity(container())
        expect(await reservationsFor(orderId)).toEqual(before.map((r) => ({ ...r })))
        await recoverOrderIntegrity(container())
        expect(await reservationsFor(orderId)).toHaveLength(1)
      })

      it("a Pair line reserves two of the Single's stock", async () => {
        const { orderId } = await codOrder(pair, 1)
        const before = await reservationsFor(orderId)
        expect(before).toEqual([expect.objectContaining({ inventory_item_id: ankletItem, quantity: 2 })])

        await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem(before.map((r) => r.line_item_id as string))
        await backdate(orderId, 10)
        await recoverOrderIntegrity(container())
        expect(await reservationsFor(orderId)).toEqual([expect.objectContaining({ inventory_item_id: ankletItem, quantity: 2 })])
      })

      it("with no free stock left, it reserves nothing and tells the team once", async () => {
        const { orderId } = await codOrder(single)
        const [row] = await reservationsFor(orderId)
        await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem([row.line_item_id as string])
        const levels = await container().resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: row.inventory_item_id })
        const original = levels.map((l) => ({ location_id: l.location_id, stocked_quantity: Number(l.stocked_quantity) }))
        await updateInventoryLevelsWorkflow(container()).run({
          input: { updates: levels.map((l) => ({ inventory_item_id: row.inventory_item_id, location_id: l.location_id, stocked_quantity: Number(l.reserved_quantity) })) },
        })
        await backdate(orderId, 10)
        try {
          await recoverOrderIntegrity(container())
          await recoverOrderIntegrity(container())
          expect(await reservationsFor(orderId)).toHaveLength(0)
          expect(storefront.alerts.filter((a) => a.type === "stock_not_reserved" && a.order_id === orderId)).toHaveLength(1)
        } finally {
          await updateInventoryLevelsWorkflow(container()).run({
            input: { updates: original.map((l) => ({ inventory_item_id: row.inventory_item_id, ...l })) },
          })
        }
      })

      it("leaves an order already handed to the courier alone", async () => {
        const { orderId } = await codOrder(single)
        const [row] = await reservationsFor(orderId)
        await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem([row.line_item_id as string])
        await createOrderDispatchWorkflow(container()).run({ input: { order_id: orderId, window_minutes: 0 } })
        await pg().raw(`UPDATE order_dispatch SET state = 'shipped' WHERE order_id = ?`, [orderId])
        await backdate(orderId, 10)
        await recoverOrderIntegrity(container())
        expect(await reservationsFor(orderId)).toHaveLength(0)
      })

      // ── Racing for the last unit ────────────────────────────

      const setFreeStock = async (free: number) => {
        const [level] = await container().resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: ankletItem })
        const original = Number(level.stocked_quantity)
        await updateInventoryLevelsWorkflow(container()).run({
          input: { updates: [{ inventory_item_id: ankletItem, location_id: level.location_id, stocked_quantity: Number(level.reserved_quantity) + free }] },
        })
        return async () => {
          const [now] = await container().resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: ankletItem })
          await updateInventoryLevelsWorkflow(container()).run({
            input: { updates: [{ inventory_item_id: ankletItem, location_id: now.location_id, stocked_quantity: Math.max(original, Number(now.reserved_quantity) + 10) }] },
          })
        }
      }
      const overdrawn = async () => {
        const [level] = await container().resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: ankletItem })
        return Number(level.reserved_quantity) > Number(level.stocked_quantity)
      }

      it("two repairs racing for the last unit: one gets it, nothing is oversold", async () => {
        const a = await codOrder(single)
        const b = await codOrder(single)
        for (const id of [a.orderId, b.orderId]) {
          const rows = await reservationsFor(id)
          await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem(rows.map((r) => r.line_item_id as string))
        }
        const restore = await setFreeStock(1)
        try {
          const [ra, rb] = await Promise.all([
            repairOrderReservationsWorkflow(container()).run({ input: { order_id: a.orderId } }),
            repairOrderReservationsWorkflow(container()).run({ input: { order_id: b.orderId } }),
          ])
          expect(ra.result.created + rb.result.created).toBe(1)
          expect(ra.result.short.length + rb.result.short.length).toBe(1)
          expect(await overdrawn()).toBe(false)
        } finally {
          await restore()
        }
      })

      it("a repair racing a live checkout for the last unit: one gets it, nothing is oversold", async () => {
        const a = await codOrder(single)
        const rows = await reservationsFor(a.orderId)
        await container().resolve(Modules.INVENTORY).deleteReservationItemsByLineItem(rows.map((r) => r.line_item_id as string))
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: single }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "cod")
        const restore = await setFreeStock(1)
        try {
          const [repair, checkout] = await Promise.all([
            repairOrderReservationsWorkflow(container()).run({ input: { order_id: a.orderId } }),
            flow.placeCod(cartId, who.email).then((id) => id, () => null),
          ])
          const restored = repair.result.created
          const placed = checkout ? 1 : 0
          expect(restored + placed).toBe(1)
          expect(await overdrawn()).toBe(false)
        } finally {
          await restore()
        }
      })

      // ── Discount codes on leftovers ──────────────────────────

      const usesOf = async (customerId: string) => {
        const { rows } = await pg().raw(
          `SELECT COALESCE(SUM(u.used), 0)::int AS used FROM promotion_campaign_budget_usage u
             JOIN promotion_campaign_budget b ON b.id = u.budget_id AND b.deleted_at IS NULL
             JOIN promotion_campaign c ON c.id = b.campaign_id
             JOIN promotion p ON p.campaign_id = c.id AND p.code = 'WELCOME200'
            WHERE u.attribute_value = ? AND u.deleted_at IS NULL`,
          [customerId]
        )
        return Number(rows[0].used)
      }

      /** A COD cart with WELCOME200 applied, ready to complete. */
      const welcomeCart = async (who?: { id: string; email: string }) => {
        const customer = who ?? (await flow.customer())
        const cartId = await flow.cart(customer.email, [{ variantId: single }])
        await flow.must(api.post(`/store/carts/${cartId}`, { email: customer.email, shipping_address: address }, { headers: flow.headers }))
        await flow.setMode(cartId, "cod")
        const applied = await flow.applyCode(cartId, "WELCOME200")
        if (!applied.ok) throw new Error(`WELCOME200 not applied: ${applied.message}`)
        return { cartId, customer }
      }

      /** What a crash after Medusa wrote the order (and maybe counted the code) leaves. */
      const crashedWelcomeAttempt = async (cartId: string, customer: { id: string; email: string }, counted: boolean) => {
        const [promotion] = await container().resolve(Modules.PROMOTION).listPromotions({ code: "WELCOME200" })
        const created = await container().resolve(Modules.ORDER).createOrders({
          region_id: fx.regionId,
          sales_channel_id: fx.salesChannelId,
          currency_code: "inr",
          customer_id: customer.id,
          email: customer.email,
          status: "pending",
          metadata: { [CHECKOUT_MARKER]: cartId },
          items: [{ title: "Anklet", variant_id: single, quantity: 1, unit_price: 2000, adjustments: [{ code: "WELCOME200", amount: 200, promotion_id: promotion.id }] }],
        } as never)
        if (counted) {
          await container().resolve(Modules.PROMOTION).registerUsage(
            [{ action: "addItemAdjustment", code: "WELCOME200", amount: 200 }] as never,
            { customer_id: customer.id, customer_email: customer.email } as never
          )
        }
        return (created as unknown as { id: string }).id
      }

      it("a crashed attempt counted WELCOME200: the customer's retry still completes, and the code stays once per customer", async () => {
        const { cartId, customer } = await welcomeCart()
        const orphan = await crashedWelcomeAttempt(cartId, customer, true)
        expect(await usesOf(customer.id)).toBe(1)

        const orderId = await flow.placeCod(cartId, customer.email)
        const { data } = await query().graph({ entity: "order", fields: ["promotions.code"], filters: { id: orderId } })
        expect((data[0] as any).promotions.map((p: any) => p.code)).toContain("WELCOME200")
        expect(await usesOf(customer.id)).toBe(1)
        const left = await metadataOf(orphan)
        expect(left.status).toBe("canceled")
        expect(left.metadata.orphan_codes_given_back).toEqual(["WELCOME200"])

        const again = await flow.cart(customer.email, [{ variantId: single }])
        await flow.setMode(again, "cod")
        expect((await flow.applyCode(again, "WELCOME200")).ok).toBe(false)
      })

      it("a crashed attempt that was never counted: nothing is given back, so no extra use is handed out", async () => {
        const { cartId, customer } = await welcomeCart()
        const orphan = await crashedWelcomeAttempt(cartId, customer, false)
        expect(await usesOf(customer.id)).toBe(0)

        await flow.placeCod(cartId, customer.email)
        expect(await usesOf(customer.id)).toBe(1)
        expect((await metadataOf(orphan)).metadata.orphan_codes_given_back).toEqual([])
      })

      it("re-entering checkout clears the leftover first, so the code stays on the cart", async () => {
        const { cartId, customer } = await welcomeCart()
        const orphan = await crashedWelcomeAttempt(cartId, customer, true)
        const summary = await flow.setMode(cartId, "cod")
        expect(summary.promo_codes).toContain("WELCOME200")
        expect((await metadataOf(orphan)).status).toBe("canceled")
        expect(await usesOf(customer.id)).toBe(0)
        await flow.placeCod(cartId, customer.email)
        expect(await usesOf(customer.id)).toBe(1)
      })

      it("any cart change (adding a line) clears the leftover before Medusa recomputes the code", async () => {
        const { cartId, customer } = await welcomeCart()
        const orphan = await crashedWelcomeAttempt(cartId, customer, true)
        await flow.must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: single, quantity: 1 }, { headers: flow.headers }))
        expect((await metadataOf(orphan)).status).toBe("canceled")
        expect((await flow.summary(cartId)).promo_codes).toContain("WELCOME200")
      })

      it("a customer who never retries gets the use back from the job", async () => {
        const { cartId, customer } = await welcomeCart()
        const orphan = await crashedWelcomeAttempt(cartId, customer, true)
        await backdate(orphan, 20)
        await recoverOrderIntegrity(container())
        expect((await metadataOf(orphan)).status).toBe("canceled")
        expect(await usesOf(customer.id)).toBe(0)

        const fresh = await welcomeCart(customer)
        await flow.placeCod(fresh.cartId, customer.email)
        expect(await usesOf(customer.id)).toBe(1)
      })

      // ── Wallet deduction ─────────────────────────────────────

      const walletOrder = async () => {
        const who = await flow.customer()
        await issueWalletCreditWorkflow(container()).run({ input: { customer_id: who.id, amount: 5000, reason: "return" } })
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1000] }])
        await flow.setMode(cartId, "prepaid")
        await applyWalletToCartWorkflow(container()).run({ input: { cart_id: cartId, customer_id: who.id } })
        await flow.must(api.post(`/store/carts/${cartId}`, { email: who.email, shipping_address: address }, { headers: flow.headers }))
        const done = await flow.attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers: flow.headers }))
        if (!done.ok) throw new Error(done.message)
        return { orderId: done.data.order.id as string, customerId: who.id }
      }

      const walletState = async (customerId: string, orderId: string) => {
        const service = container().resolve(WALLET_MODULE) as any
        const [wallet] = await service.listWallets({ customer_id: customerId })
        const redemptions = await service.listWalletTransactions({ reference: redemptionReference(orderId) })
        return { balance: Number(wallet.balance), redemptions }
      }

      /** Undoes a redemption, as if order.placed had never reached the wallet subscriber. */
      const loseRedemption = async (customerId: string, orderId: string) => {
        const service = container().resolve(WALLET_MODULE) as any
        const { redemptions } = await walletState(customerId, orderId)
        const tx = redemptions[0]
        for (const allocation of tx.metadata.allocations) {
          await service.updateWalletTransactions({ id: allocation.lot_id, remaining: allocation.previous_remaining })
        }
        const [wallet] = await service.listWallets({ customer_id: customerId })
        await service.updateWallets({ id: wallet.id, balance: Number(wallet.balance) + Number(tx.amount) })
        await service.deleteWalletTransactions(tx.id)
      }

      it("deducts wallet credit whose order-placed event was lost, once", async () => {
        const { orderId, customerId } = await walletOrder()
        await new Promise((r) => setTimeout(r, 1500))
        const deducted = await walletState(customerId, orderId)
        expect(deducted.redemptions).toHaveLength(1)

        await loseRedemption(customerId, orderId)
        expect((await walletState(customerId, orderId)).redemptions).toHaveLength(0)
        await backdate(orderId, 15)

        await recoverOrderIntegrity(container())
        const after = await walletState(customerId, orderId)
        expect(after.redemptions).toHaveLength(1)
        expect(after.balance).toBe(deducted.balance)

        await recoverOrderIntegrity(container())
        await Promise.all([
          redeemWalletForOrderWorkflow(container()).run({ input: { order_id: orderId } }),
          redeemWalletForOrderWorkflow(container()).run({ input: { order_id: orderId } }),
        ])
        const final = await walletState(customerId, orderId)
        expect(final.redemptions).toHaveLength(1)
        expect(final.balance).toBe(deducted.balance)
      })

      it("does not deduct credit for an order that was cancelled first", async () => {
        const { orderId, customerId } = await walletOrder()
        await new Promise((r) => setTimeout(r, 1500))
        await loseRedemption(customerId, orderId)
        await pg().raw(`UPDATE "order" SET status = 'canceled' WHERE id = ?`, [orderId])
        await backdate(orderId, 15)
        const before = await walletState(customerId, orderId)
        await recoverOrderIntegrity(container())
        expect(await walletState(customerId, orderId)).toEqual(before)
      })

      // ── Confirmation emails ──────────────────────────────────

      it("retries an unsent confirmation email with backoff and sends it once", async () => {
        const { orderId } = await codOrder()
        await backdate(orderId, 15)

        storefront.behaviour.email = "fail"
        await recoverOrderIntegrity(container())
        let meta = (await metadataOf(orderId)).metadata
        expect(meta.confirmation_email_attempts).toBe(1)
        expect(new Date(meta.confirmation_email_next_at).getTime()).toBeGreaterThan(Date.now())

        // Not due yet: no call.
        await recoverOrderIntegrity(container())
        expect(storefront.emailCalls.filter((id) => id === orderId)).toHaveLength(1)

        await pg().raw(`UPDATE "order" SET metadata = metadata || '{"confirmation_email_next_at": "2000-01-01T00:00:00Z"}'::jsonb WHERE id = ?`, [orderId])
        storefront.behaviour.email = "send"
        await recoverOrderIntegrity(container())
        meta = (await metadataOf(orderId)).metadata
        expect(meta.confirmation_email_sent).toBe(true)

        await recoverOrderIntegrity(container())
        expect(storefront.emailCalls.filter((id) => id === orderId)).toHaveLength(2)
      })

      it("gives up after the last retry and tells the team", async () => {
        const { orderId } = await codOrder()
        await backdate(orderId, 15)
        await pg().raw(`UPDATE "order" SET metadata = metadata || '{"confirmation_email_attempts": 5}'::jsonb WHERE id = ?`, [orderId])
        storefront.behaviour.email = "fail"
        await recoverOrderIntegrity(container())
        expect((await metadataOf(orderId)).metadata.confirmation_email_gave_up).toBe("failed")
        expect(storefront.alerts.filter((a) => a.type === "confirmation_email_failed" && a.order_id === orderId)).toHaveLength(1)
        await recoverOrderIntegrity(container())
        expect(storefront.emailCalls.filter((id) => id === orderId)).toHaveLength(1)
      })

      it("stops when email is not configured, and never emails about an unpaid order", async () => {
        const { orderId } = await codOrder()
        await backdate(orderId, 15)
        storefront.behaviour.email = "skip"
        await recoverOrderIntegrity(container())
        expect((await metadataOf(orderId)).metadata.confirmation_email_gave_up).toBe("email_not_configured")

        const unpaid = await codOrder()
        const { data } = await query().graph({ entity: "order", fields: ["payment_collections.id"], filters: { id: unpaid.orderId } })
        const collectionId = (data[0] as any).payment_collections[0].id
        await pg().raw(`DELETE FROM payment WHERE payment_collection_id = ?`, [collectionId])
        await backdate(unpaid.orderId, 15)
        storefront.behaviour.email = "send"
        await recoverOrderIntegrity(container())
        expect(storefront.emailCalls).not.toContain(unpaid.orderId)
      })

      // ── Manual dispatch override ─────────────────────────────

      const adminOrder = async (paid: boolean) => {
        const order = await leftoverOrder(null, "phone-order@example.com")
        if (paid) {
          const { result: collections } = await createOrderPaymentCollectionWorkflow(container()).run({ input: { order_id: order.id, amount: 2000 } })
          await markPaymentCollectionAsPaid(container()).run({ input: { order_id: order.id, payment_collection_id: (collections as any)[0].id } })
        }
        return order.id
      }

      const override = (orderId: string, headers: Record<string, string>, reason = "Phone order, paid by bank transfer") =>
        flow.attempt(api.post(`/admin/orders/${orderId}/dispatch-override`, { reason }, { headers }))

      it("a staff member can release a paid admin-made order; it is audited and can be withdrawn", async () => {
        const orderId = await adminOrder(true)
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: false, reason: "no_cart" })

        const granted = await override(orderId, staff)
        expect(granted.ok).toBe(true)
        expect(granted.data.override).toMatchObject({ order_id: orderId, actor_id: staffId, held_reason: "no_cart", revoked_at: null })
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: true, kind: "override" })
        expect(storefront.alerts.map((a) => a.type)).toContain("dispatch_override")

        await createOrderDispatchWorkflow(container()).run({ input: { order_id: orderId, window_minutes: 0 } })
        const { result: claim } = await dispatchOrderWorkflow(container()).run({ input: { order_id: orderId, force: true } })
        expect(claim.reason).not.toBe("payment_not_confirmed")

        expect(await override(orderId, staff)).toMatchObject({ ok: false, status: 400 })

        const withdrawn = await flow.attempt(api.delete(`/admin/orders/${orderId}/dispatch-override`, { headers: staff }))
        expect(withdrawn.ok && withdrawn.data.override.revoked_by).toBe(staffId)
        expect(await loadPaymentStanding(container(), orderId)).toMatchObject({ ok: false, reason: "no_cart" })
        const { data: audit } = await query().graph({ entity: "dispatch_override", fields: ["actor_id", "reason", "revoked_at"], filters: { order_id: orderId } })
        expect(audit).toHaveLength(1)
      })

      it("refuses an API key, a missing reason, an unpaid order and a checkout leftover", async () => {
        const paid = await adminOrder(true)
        expect(await override(paid, apiKey)).toMatchObject({ ok: false, status: 401 })
        expect(await override(paid, {})).toMatchObject({ ok: false, status: 401 })
        expect(await override(paid, staff, "short")).toMatchObject({ ok: false, status: 400 })

        const unpaid = await adminOrder(false)
        const refused = await override(unpaid, staff)
        expect(refused).toMatchObject({ ok: false, status: 400 })
        expect(refused.message).toContain("Record the payment")

        const real = await codOrder()
        const orphan = await leftoverOrder(real.cartId, real.email)
        expect((await override(orphan.id, staff)).message).toContain("started by a checkout")
        expect(await loadPaymentStanding(container(), orphan.id)).toMatchObject({ ok: false })
      })

      it("shows why an order is held, and whether it can be released, in the Shipping panel data", async () => {
        const orderId = await adminOrder(true)
        const panel = await flow.must(api.get(`/admin/orders/${orderId}/dispatch`, { headers: staff }))
        expect(panel.payment_standing).toMatchObject({ ok: false, reason: "no_cart" })
        expect(panel.can_override).toBe(true)
        const { orderId: cod } = await codOrder()
        const codPanel = await flow.must(api.get(`/admin/orders/${cod}/dispatch`, { headers: staff }))
        expect(codPanel.payment_standing).toMatchObject({ ok: true })
        expect(codPanel.can_override).toBe(false)
      })
    })
  },
})
