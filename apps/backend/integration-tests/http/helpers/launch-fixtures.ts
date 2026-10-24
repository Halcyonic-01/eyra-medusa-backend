import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createStoresWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows"
import { setupLaunchCommerce } from "../../../src/utils/setup-launch-commerce"

export type LaunchFixtures = {
  publishableKey: string
  regionId: string
  salesChannelId: string
  /** variant id by unit price, for the probe product */
  variantByPrice: Record<number, string>
  customerEmail: string
  customerId: string
}

/** Prices the tests need a single-line cart for. */
export const PROBE_PRICES = [1000, 1499, 1500, 1600, 2000, 2999, 3000, 3001, 3500, 4000, 5000, 5001, 6000, 7000, 12000]

/**
 * Everything checkout needs in an empty test database: a store, region,
 * delivery zone, a published probe product with one variant per price, the
 * launch setup (shipping options and codes) and a customer with an account.
 */
export async function seedLaunchFixtures(container: MedusaContainer): Promise<LaunchFixtures> {
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillment = container.resolve(Modules.FULFILLMENT)

  const {
    result: [salesChannel],
  } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "EYRA Storefront" }] },
  })

  const {
    result: [apiKey],
  } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: "test", type: "publishable", created_by: "" }] },
  })
  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: apiKey.id, add: [salesChannel.id] },
  })

  await createStoresWorkflow(container).run({
    input: {
      stores: [
        {
          name: "EYRA",
          supported_currencies: [{ currency_code: "inr", is_default: true }],
          default_sales_channel_id: salesChannel.id,
        },
      ],
    },
  })

  const {
    result: [region],
  } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "India",
          currency_code: "inr",
          countries: ["in"],
          payment_providers: ["pp_system_default", "pp_razorpay_razorpay"],
        },
      ],
    },
  })
  await createTaxRegionsWorkflow(container).run({
    input: [{ country_code: "in", provider_id: "tp_system" }],
  })

  const {
    result: [stockLocation],
  } = await createStockLocationsWorkflow(container).run({
    input: { locations: [{ name: "Warehouse", address: { city: "Mumbai", country_code: "IN", address_1: "" } }] },
  })
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  })

  const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
  let profileId = profiles[0]?.id as string | undefined
  if (!profileId) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default", type: "default" }] },
    })
    profileId = result[0].id
  }

  const fulfillmentSet = await fulfillment.createFulfillmentSets({
    name: "India delivery",
    type: "shipping",
    service_zones: [{ name: "India", geo_zones: [{ country_code: "in", type: "country" }] }],
  })
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  })
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocation.id, add: [salesChannel.id] },
  })

  // The seed's placeholder option; the launch setup copies its zone and profile.
  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard Shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: profileId!,
        type: { label: "Standard", description: "Standard", code: "standard" },
        prices: [{ currency_code: "inr", amount: 0 }],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  })

  // The tote starts with some stock, so an order that qualifies can get one.
  // (A blank value in a .env file counts as unset.)
  process.env.TOTE_INITIAL_STOCK = process.env.TOTE_INITIAL_STOCK || "5"
  await setupLaunchCommerce(container)

  await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Probe",
          handle: "probe",
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: profileId!,
          sales_channels: [{ id: salesChannel.id }],
          options: [{ title: "Price", values: PROBE_PRICES.map(String) }],
          variants: PROBE_PRICES.map((amount) => ({
            title: String(amount),
            sku: `PROBE-${amount}`,
            manage_inventory: false,
            options: { Price: String(amount) },
            prices: [{ amount, currency_code: "inr" }],
          })),
        },
      ],
    },
  })
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["variants.id", "variants.sku"],
    filters: { handle: "probe" },
  })
  const variantByPrice: Record<number, string> = {}
  for (const variant of products[0].variants) {
    variantByPrice[Number(String(variant.sku).replace("PROBE-", ""))] = variant.id
  }

  const customerEmail = "shopper@example.com"
  const customer = await container.resolve(Modules.CUSTOMER).createCustomers({
    email: customerEmail,
    has_account: true,
  })

  return {
    publishableKey: apiKey.token,
    regionId: region.id,
    salesChannelId: salesChannel.id,
    variantByPrice,
    customerEmail,
    customerId: customer.id,
  }
}

/** True when the shipping options or codes are missing. */
export async function launchSetupIsNeeded(container: MedusaContainer): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: options } = await query.graph({ entity: "shipping_option", fields: ["type.code"] })
  const { data: promotions } = await query.graph({ entity: "promotion", fields: ["code"] })
  const codes = new Set(options.map((option) => option.type?.code))
  return !(codes.has("eyra-prepaid") && codes.has("eyra-cod") && promotions.length === 3)
}

/** Sets how many complimentary totes are in stock, so a long suite does not run out of them. */
export async function setToteStock(container: MedusaContainer, quantity: number): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "location_levels.location_id"],
    filters: { sku: "EYRA-TOTE" },
  })
  const item = data[0] as any
  await updateInventoryLevelsWorkflow(container).run({
    input: { updates: [{ inventory_item_id: item.id, location_id: item.location_levels[0].location_id, stocked_quantity: quantity }] },
  })
}
