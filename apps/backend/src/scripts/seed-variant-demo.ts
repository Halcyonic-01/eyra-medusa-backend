import type { CreateProductWorkflowInputDTO, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, ProductStatus } from "@medusajs/framework/utils"
import {
  createInventoryLevelsWorkflow,
  createProductTypesWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Two example products that use the new variant choices, for trying the
 * storefront locally. Not for production: in production, create the real anklets
 * and pendants in the Medusa admin the same way (see docs/launch-commerce.md).
 *
 *   - Luna Anklet: Pack = Single or Pair. The pair is 1.9 x the single.
 *   - Moonstone Pendant: Chain = Pendant only, or With silver chain (+Rs 1,000).
 *
 * Safe to run twice; it skips products that exist. Run with:
 *
 *   npx medusa exec ./src/scripts/seed-variant-demo.ts
 */

const IMG = "https://www.eyra.org.in/images"

/** The pair price rule: 1.9 x the single, rounded to the rupee. */
export const pairPrice = (single: number) => Math.round(single * 1.9)

/** What a silver chain adds to a pendant. */
const CHAIN_ADD_ON = 1000

export default async function seedVariantDemo({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: channels } = await query.graph({ entity: "sales_channel", fields: ["id", "name"] })
  const channel = channels.find((entry) => entry.name === "EYRA Storefront") ?? channels[0]
  const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
  const { data: locations } = await query.graph({ entity: "stock_location", fields: ["id"] })
  if (!channel || !profiles[0] || !locations[0]) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Run the base seed first: the sales channel, shipping profile and stock location are missing.")
  }

  const { data: existingTypes } = await query.graph({ entity: "product_type", fields: ["id", "value"] })
  const typeId = new Map(existingTypes.map((type) => [type.value, type.id]))
  const missingTypes = ["anklet", "pendant"].filter((value) => !typeId.has(value))
  if (missingTypes.length) {
    const { result } = await createProductTypesWorkflow(container).run({
      input: { product_types: missingTypes.map((value) => ({ value })) },
    })
    for (const type of result) typeId.set(type.value, type.id)
  }

  const { data: existing } = await query.graph({
    entity: "product",
    fields: ["handle"],
    filters: { handle: ["luna-anklet", "moonstone-pendant"] },
  })
  const have = new Set(existing.map((product) => product.handle))

  const products: CreateProductWorkflowInputDTO[] = []

  if (!have.has("luna-anklet")) {
    const single = 2000
    products.push({
      title: "Luna Anklet",
      handle: "luna-anklet",
      description: "A delicate 925 sterling silver anklet. Wear one, or take the pair.",
      status: ProductStatus.PUBLISHED,
      type_id: typeId.get("anklet"),
      thumbnail: `${IMG}/product-2.jpg`,
      images: [{ url: `${IMG}/product-2.jpg` }, { url: `${IMG}/product-3.jpg` }],
      weight: 10,
      metadata: { rating: 4.6, review_count: 42 },
      shipping_profile_id: profiles[0].id,
      sales_channels: [{ id: channel.id }],
      options: [{ title: "Pack", values: ["Single", "Pair"] }],
      variants: [
        {
          title: "Single",
          sku: "luna-anklet-single",
          manage_inventory: true,
          options: { Pack: "Single" },
          prices: [{ amount: single, currency_code: "inr" }],
        },
        {
          title: "Pair",
          sku: "luna-anklet-pair",
          manage_inventory: true,
          options: { Pack: "Pair" },
          prices: [{ amount: pairPrice(single), currency_code: "inr" }],
        },
      ],
    })
  }

  if (!have.has("moonstone-pendant")) {
    const base = 1800
    products.push({
      title: "Moonstone Pendant",
      handle: "moonstone-pendant",
      description: "A moonstone pendant in 925 sterling silver. Add a silver chain if you want to wear it today.",
      status: ProductStatus.PUBLISHED,
      type_id: typeId.get("pendant"),
      thumbnail: `${IMG}/product-3.jpg`,
      images: [{ url: `${IMG}/product-3.jpg` }, { url: `${IMG}/product-4.jpg` }],
      weight: 12,
      metadata: { rating: 4.5, review_count: 18 },
      shipping_profile_id: profiles[0].id,
      sales_channels: [{ id: channel.id }],
      options: [{ title: "Chain", values: ["Pendant only", "With silver chain"] }],
      variants: [
        {
          title: "Pendant only",
          sku: "moonstone-pendant-only",
          manage_inventory: true,
          options: { Chain: "Pendant only" },
          prices: [{ amount: base, currency_code: "inr" }],
        },
        {
          title: "With silver chain",
          sku: "moonstone-pendant-chain",
          manage_inventory: true,
          options: { Chain: "With silver chain" },
          prices: [{ amount: base + CHAIN_ADD_ON, currency_code: "inr" }],
        },
      ],
    })
  }

  if (products.length) {
    await createProductsWorkflow(container).run({ input: { products } })
  }

  // Each variant is stocked on its own. The "With silver chain" stock is the
  // number of pendants set aside with a chain, separate from the chain products.
  // Levels are filled in for any of the four that has none, so a rerun repairs a
  // half-finished first run.
  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "location_levels.id"],
    filters: { sku: ["luna-anklet-single", "luna-anklet-pair", "moonstone-pendant-only", "moonstone-pendant-chain"] },
  })
  const unstocked = items.filter((item) => !item.location_levels?.length)
  if (unstocked.length) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: unstocked.map((item) => ({
          location_id: locations[0].id,
          inventory_item_id: item.id,
          stocked_quantity: 25,
        })),
      },
    })
  }

  logger.info(`Demo products ready (${products.length} created, ${unstocked.length} stocked)`)
}
