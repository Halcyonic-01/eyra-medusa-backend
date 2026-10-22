import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutFlow } from "./helpers/checkout-flow"
import { seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""
process.env.ORDER_DISPATCH_ENABLED = "false"

jest.setTimeout(240000)

// The complimentary tote is a real product at a price of zero: it travels as a
// line on the cart, the order and the shipment, and its stock is counted. It goes
// to orders with items worth strictly more than 1,499, one per order, while stock lasts.

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("complimentary tote", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>

      const toteStock = async () => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "inventory_item",
          fields: ["id", "location_levels.id", "location_levels.location_id", "location_levels.stocked_quantity", "location_levels.reserved_quantity"],
          filters: { sku: "EYRA-TOTE" },
        })
        const item = data[0] as any
        const level = item.location_levels[0]
        return {
          itemId: item.id as string,
          locationId: level.location_id as string,
          stocked: Number(level.stocked_quantity),
          reserved: Number(level.reserved_quantity),
        }
      }

      const setToteStock = async (quantity: number) => {
        const { itemId, locationId } = await toteStock()
        await updateInventoryLevelsWorkflow(getContainer()).run({
          input: { updates: [{ inventory_item_id: itemId, location_id: locationId, stocked_quantity: quantity }] },
        })
      }

      const totes = (cart: any) => cart.items.filter((line: any) => line.complimentary)

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
      })

      it("is set up as a hidden product at a price of zero, with its own stock", async () => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "product",
          fields: ["status", "metadata", "variants.sku", "variants.manage_inventory", "variants.prices.amount", "variants.prices.currency_code"],
          filters: { handle: "eyra-complimentary-tote" },
        })
        const product = data[0] as any
        expect(product.status).toBe("published")
        expect(product.metadata.hidden_from_shop).toBe("true")
        expect(product.variants).toHaveLength(1)
        expect(product.variants[0].sku).toBe("EYRA-TOTE")
        expect(product.variants[0].manage_inventory).toBe(true)
        expect(product.variants[0].prices.map((p: any) => [p.currency_code, Number(p.amount)])).toEqual([["inr", 0]])
        expect((await toteStock()).stocked).toBe(5)
      })

      it("is not given at 1,499 and is given at 1,500", async () => {
        const who = await flow.customer()

        const at1499 = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1499] }])
        const low = await flow.reconcile(at1499)
        expect(low.tote_status).toBe("unchanged")
        expect(totes(low.cart)).toHaveLength(0)
        expect(low.cart.tote).toEqual({ qualifies: false, in_cart: false })

        const at1500 = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1500] }])
        const high = await flow.reconcile(at1500)
        expect(high.tote_status).toBe("added")
        expect(totes(high.cart)).toHaveLength(1)
        expect(totes(high.cart)[0]).toMatchObject({ quantity: 1, unit_price: 0, complimentary: true })
        expect(high.cart.tote).toEqual({ qualifies: true, in_cart: true })
      })

      it("changes no price: items, discount and total are the same with it", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[3000] }])
        const before = await flow.summary(cartId)
        const { cart: after } = await flow.reconcile(cartId)
        expect(totes(after)).toHaveLength(1)
        expect(after.totals.items_subtotal).toBe(before.totals.items_subtotal)
        expect(after.totals.total).toBe(before.totals.total)
        expect(after.totals.items_subtotal).toBe(3000)
      })

      it("does not count towards a discount threshold, and a code still applies", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1500] }])
        await flow.reconcile(cartId)
        const applied = await flow.applyCode(cartId, "WELCOME200")
        expect(applied.ok).toBe(true)
        const cart = await flow.summary(cartId)
        expect(cart.totals.discount_total).toBe(200)
        expect(cart.totals.items_subtotal).toBe(1500)
      })

      it("is taken off again when the items no longer qualify", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1000] }, { variantId: fx.variantByPrice[1500] }])
        const first = await flow.reconcile(cartId)
        expect(first.tote_status).toBe("added")

        const line = first.cart.items.find((item: any) => item.unit_price === 1500)
        await flow.removeLine(cartId, line.id)
        const second = await flow.reconcile(cartId)
        expect(second.tote_status).toBe("removed")
        expect(totes(second.cart)).toHaveLength(0)
        expect(second.cart.totals.items_subtotal).toBe(1000)
      })

      it("is one per order however often it is reconciled", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[3500] }])
        await flow.reconcile(cartId)
        await flow.reconcile(cartId)
        const { cart } = await flow.reconcile(cartId)
        expect(totes(cart)).toHaveLength(1)
        expect(totes(cart)[0].quantity).toBe(1)
      })

      it("becomes a free line on the order and takes one from its own stock", async () => {
        await setToteStock(5)
        const before = await toteStock()
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        await flow.reconcile(cartId)
        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)

        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "order",
          fields: ["total", "item_subtotal", "items.variant_sku", "items.unit_price", "items.quantity", "items.detail.quantity"],
          filters: { id: orderId },
        })
        const order = data[0] as any
        const tote = order.items.find((item: any) => item.variant_sku === "EYRA-TOTE")
        expect(tote).toBeDefined()
        expect(Number(tote.unit_price)).toBe(0)
        expect(Number(tote.detail?.quantity ?? tote.quantity)).toBe(1)
        // 2,000 of jewellery and the 99 Cash on Delivery charge: the tote adds nothing.
        expect(Number(order.total)).toBe(2099)
        expect(Number(order.item_subtotal)).toBe(2000)

        const after = await toteStock()
        expect(after.reserved).toBe(before.reserved + 1)
        expect(after.stocked).toBe(before.stocked)
      })

      it("is skipped, not an error, when it is out of stock: the order still goes through", async () => {
        await setToteStock(0)
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[2000] }])
        const result = await flow.reconcile(cartId)
        expect(result.tote_status).toBe("out_of_stock")
        expect(totes(result.cart)).toHaveLength(0)
        expect(result.cart.tote).toEqual({ qualifies: true, in_cart: false })

        await flow.setMode(cartId, "cod")
        const orderId = await flow.placeCod(cartId, who.email)
        expect(orderId).toMatch(/^order_/)
        await setToteStock(5)
      })

      it("cannot be added by hand to an order that does not qualify", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[1499] }])
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { sku: "EYRA-TOTE" } })
        await flow.must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: (data[0] as any).id, quantity: 1 }, { headers: flow.headers }))
        await flow.setMode(cartId, "cod")
        const placed = await flow.attempt(
          (async () => {
            await flow.placeCod(cartId, who.email)
            return { data: {} }
          })()
        )
        expect(placed.ok).toBe(false)
      })

      it("cannot be doubled by hand on an order that does", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: fx.variantByPrice[3000] }])
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { sku: "EYRA-TOTE" } })
        const toteVariant = (data[0] as any).id
        await flow.must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: toteVariant, quantity: 2 }, { headers: flow.headers }))
        await flow.setMode(cartId, "cod")
        const placed = await flow.attempt(
          (async () => {
            await flow.placeCod(cartId, who.email)
            return { data: {} }
          })()
        )
        expect(placed.ok).toBe(false)
        // The storefront's own call puts it right.
        const { cart } = await flow.reconcile(cartId)
        expect(totes(cart)).toHaveLength(1)
        expect(totes(cart)[0].quantity).toBe(1)
      })
    })
  },
})
