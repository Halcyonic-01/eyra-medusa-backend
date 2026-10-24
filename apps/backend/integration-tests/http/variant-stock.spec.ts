import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils"
import { createInventoryLevelsWorkflow, createProductsWorkflow } from "@medusajs/medusa/core-flows"
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

// Each pendant variant is stocked on its own: a pendant sold with a silver chain
// takes from the "with chain" stock only, and a pendant sold alone from its own.

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("pendant stock", () => {
      let fx: LaunchFixtures
      let flow: ReturnType<typeof checkoutFlow>
      let plainVariant: string
      let chainVariant: string

      const stock = async () => {
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "inventory_item",
          fields: ["id", "sku", "location_levels.stocked_quantity", "location_levels.reserved_quantity"],
          filters: { sku: ["pendant-only", "pendant-chain"] },
        })
        const bySku: Record<string, { stocked: number; reserved: number }> = {}
        for (const item of data as any[]) {
          const level = item.location_levels?.[0]
          bySku[item.sku] = { stocked: Number(level?.stocked_quantity), reserved: Number(level?.reserved_quantity) }
        }
        return bySku
      }

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        flow = checkoutFlow(api, getContainer, fx)
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)

        const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
        const { data: locations } = await query.graph({ entity: "stock_location", fields: ["id"] })

        await createProductsWorkflow(getContainer()).run({
          input: {
            products: [
              {
                title: "Pendant",
                handle: "pendant",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: profiles[0].id,
                sales_channels: [{ id: fx.salesChannelId }],
                options: [{ title: "Chain", values: ["Pendant only", "With silver chain"] }],
                variants: [
                  { title: "Pendant only", sku: "pendant-only", manage_inventory: true, options: { Chain: "Pendant only" }, prices: [{ amount: 1800, currency_code: "inr" }] },
                  { title: "With silver chain", sku: "pendant-chain", manage_inventory: true, options: { Chain: "With silver chain" }, prices: [{ amount: 2800, currency_code: "inr" }] },
                ],
              },
            ],
          },
        })

        const { data: items } = await query.graph({ entity: "inventory_item", fields: ["id", "sku"], filters: { sku: ["pendant-only", "pendant-chain"] } })
        // Different stock for each, so a mix-up would show.
        const stockFor: Record<string, number> = { "pendant-only": 10, "pendant-chain": 3 }
        await createInventoryLevelsWorkflow(getContainer()).run({
          input: {
            inventory_levels: (items as any[]).map((item) => ({
              location_id: locations[0].id,
              inventory_item_id: item.id,
              stocked_quantity: stockFor[item.sku],
            })),
          },
        })

        const { data: products } = await query.graph({ entity: "product", fields: ["variants.id", "variants.sku"], filters: { handle: "pendant" } })
        const variants = (products[0] as any).variants as { id: string; sku: string }[]
        plainVariant = variants.find((v) => v.sku === "pendant-only")!.id
        chainVariant = variants.find((v) => v.sku === "pendant-chain")!.id
      })

      it("starts with separate stock for each variant", async () => {
        expect(await stock()).toEqual({
          "pendant-only": { stocked: 10, reserved: 0 },
          "pendant-chain": { stocked: 3, reserved: 0 },
        })
      })

      it("selling a pendant with a chain takes only from the with-chain stock", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: chainVariant }])
        await flow.setMode(cartId, "cod")
        await flow.placeCod(cartId, who.email)

        expect(await stock()).toEqual({
          "pendant-only": { stocked: 10, reserved: 0 },
          "pendant-chain": { stocked: 3, reserved: 1 },
        })
      })

      it("selling a pendant alone takes only from the pendant-only stock", async () => {
        const who = await flow.customer()
        const cartId = await flow.cart(who.email, [{ variantId: plainVariant, quantity: 2 }])
        await flow.setMode(cartId, "cod")
        await flow.placeCod(cartId, who.email)

        expect(await stock()).toEqual({
          "pendant-only": { stocked: 10, reserved: 2 },
          "pendant-chain": { stocked: 3, reserved: 1 },
        })
      })

      it("refuses a pendant with a chain once that stock is gone, even though plain pendants remain", async () => {
        const who = await flow.customer()
        // 3 in stock, 1 already reserved: two more fit, a third does not.
        const ok = await flow.attempt(
          api.post(
            "/store/carts",
            { region_id: fx.regionId, sales_channel_id: fx.salesChannelId, email: who.email },
            { headers: flow.headers }
          )
        )
        const cartId = (ok as any).data.cart.id
        const tooMany: any = await flow.attempt(
          api.post(`/store/carts/${cartId}/line-items`, { variant_id: chainVariant, quantity: 3 }, { headers: flow.headers })
        )
        expect(tooMany.ok).toBe(false)

        const plain: any = await flow.attempt(
          api.post(`/store/carts/${cartId}/line-items`, { variant_id: plainVariant, quantity: 3 }, { headers: flow.headers })
        )
        expect(plain.ok).toBe(true)
      })
    })
  },
})
