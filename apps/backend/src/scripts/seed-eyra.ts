/**
 * EYRA catalogue seed.
 *
 * Run with: npx medusa exec ./src/scripts/seed-eyra.ts
 *
 * Populates the 9 products that were previously hardcoded as mock data in
 * the frontend's lib/products.ts, shaped exactly as apps' storefront
 * lib/medusa.ts expects:
 *   - product.type.value      → "ring" | "chain" (normalizeType)
 *   - product.tags[].value    → spec badges (toDetailProduct)
 *   - product option "Size"   → ring size picker + sizeVariantMap (rings only)
 *   - product.metadata        → rating, review_count
 *
 * IMPORTANT — price format: Medusa v2 stores `amount` in MAJOR units, not
 * paise. ₹2,499 is seeded here as `2499`, not `249900`. (Confirmed against
 * the installed @medusajs/pricing Price model — `amount` is a bigNumber
 * field storing the decimal price directly, and Medusa's own demo seed
 * script does the same: `amount: 10` for a €10 shirt.)
 *
 * The storefront's lib/medusa.ts and lib/medusa-cart.ts currently divide
 * every amount by 100 assuming paise — that assumption predates this
 * backend and needs fixing there before real prices will display correctly.
 */
import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createProductTagsWorkflow,
  createProductTypesWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createStoresWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows";

/* ── Product data (ported from the frontend's lib/products.ts) ────────── */

type ProductType = "ring" | "chain";

const RING_SIZES = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const RING_SPECS = ["925 Sterling", "Hallmarked", "BIS Certified", "Anti-tarnish"];
const CHAIN_SPECS = ["925 Sterling", "Nickel Free", "Hallmarked", "Anti-tarnish"];

// Matches config/storeConfig.ts's itemWeightsG on the frontend, in grams.
const TYPE_WEIGHT_G: Record<ProductType, number> = {
  ring: 6,
  chain: 15,
};

// Images are served from the storefront itself — no separate media host
// (Cloudinary etc.) is wired up yet. Update if the canonical domain changes.
const IMG_BASE = "https://www.eyra.org.in/images";

interface SeedProduct {
  handle: string;
  name: string;
  price: number; // rupees, major units
  originalPrice: number; // informational only — Medusa has no seeded compare-at
  description: string;
  images: string[]; // filenames under /images
  inStock: number;
  type: ProductType;
  rating: number;
  reviewCount: number;
}

const PRODUCTS: SeedProduct[] = [
  { handle: "eyra-signature-silver-ring", name: "Eyra Signature Silver Ring", price: 2499, originalPrice: 4499, description: "Crafted in premium 925 sterling silver with a sleek minimal finish designed for timeless elegance.", images: ["product-1.jpg", "product-2.jpg", "collection-1.jpg", "product-3.jpg"], inStock: 15, type: "ring", rating: 4.4, reviewCount: 128 },
  { handle: "celestial-band-ring", name: "Celestial Band Ring", price: 1899, originalPrice: 3299, description: "Delicately textured band in 925 sterling silver, perfect for everyday stacking and layering.", images: ["product-2.jpg", "product-1.jpg", "collection-2.jpg", "product-4.jpg"], inStock: 8, type: "ring", rating: 4.2, reviewCount: 84 },
  { handle: "serpentine-silver-chain", name: "Serpentine Silver Chain", price: 3299, originalPrice: 5499, description: "A bold serpentine-link chain in 925 sterling silver, engineered for modern luxury and durability.", images: ["product-3.jpg", "product-1.jpg", "collection-3.jpg", "product-5.jpg"], inStock: 12, type: "chain", rating: 4.6, reviewCount: 210 },
  { handle: "sovereign-signet-ring", name: "Sovereign Signet Ring", price: 4999, originalPrice: 7499, description: "A heavy-gauge signet ring in pure 925 sterling silver, hand-polished to a mirror finish.", images: ["product-1.jpg", "product-3.jpg", "collection-3.jpg", "product-2.jpg"], inStock: 5, type: "ring", rating: 4.7, reviewCount: 62 },
  { handle: "rope-twist-chain", name: "Rope Twist Chain", price: 1499, originalPrice: 2799, description: "Classic rope-twist link chain in 925 sterling silver, timeless and versatile for all looks.", images: ["product-2.jpg", "product-3.jpg", "collection-1.jpg", "product-5.jpg"], inStock: 30, type: "chain", rating: 4.1, reviewCount: 145 },
  { handle: "figaro-link-chain", name: "Figaro Link Chain", price: 2799, originalPrice: 4799, description: "The iconic Figaro pattern reimagined in sterling silver — a staple for the modern wardrobe.", images: ["product-3.jpg", "product-2.jpg", "collection-2.jpg", "product-4.jpg"], inStock: 14, type: "chain", rating: 4.4, reviewCount: 88 },
  { handle: "eternity-stacking-ring", name: "Eternity Stacking Ring", price: 3499, originalPrice: 5999, description: "A slim eternity band set with hand-placed cubic zirconia in gleaming 925 sterling silver.", images: ["product-4.jpg", "product-1.jpg", "collection-3.jpg", "product-3.jpg"], inStock: 7, type: "ring", rating: 4.8, reviewCount: 203 },
  { handle: "geometric-dome-ring", name: "Geometric Dome Ring", price: 2999, originalPrice: 5299, description: "An architectural dome ring in 925 sterling silver, a statement piece for the design-forward.", images: ["product-1.jpg", "product-5.jpg", "collection-2.jpg", "product-2.jpg"], inStock: 9, type: "ring", rating: 4.5, reviewCount: 111 },
  { handle: "box-link-statement-chain", name: "Box Link Statement Chain", price: 5499, originalPrice: 8999, description: "Chunky box-link chain in heavyweight 925 sterling silver — bold, structural, and unforgettable.", images: ["product-2.jpg", "product-3.jpg", "collection-3.jpg", "product-4.jpg"], inStock: 4, type: "chain", rating: 4.6, reviewCount: 74 },
];

const ALL_SPECS = Array.from(
  new Set([...RING_SPECS, ...CHAIN_SPECS])
);

function specsFor(type: ProductType): string[] {
  if (type === "ring") return RING_SPECS;
  return CHAIN_SPECS;
}

/** Spreads a product's total mock stock across its variants, summing back to (near) the original. */
function distributeStock(total: number, variantCount: number): number[] {
  const base = Math.floor(total / variantCount);
  const remainder = total % variantCount;
  return Array.from({ length: variantCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/* ── Seed ─────────────────────────────────────────────────────────────── */

export default async function seedEyra({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillmentModuleService = container.resolve(ModuleRegistrationName.FULFILLMENT);

  logger.info("Seeding EYRA store data...");

  const {
    result: [salesChannel],
  } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "EYRA Storefront" }] },
  });

  const {
    result: [publishableApiKey],
  } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [{ title: "EYRA Storefront Key", type: "publishable", created_by: "" }],
    },
  });

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: publishableApiKey.id, add: [salesChannel.id] },
  });

  logger.info(`Publishable API key created: ${publishableApiKey.token}`);
  logger.info("^ Set this as NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY on the frontend.");

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
  });

  logger.info("Seeding India region...");
  const {
    result: [region],
  } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "India",
          currency_code: "inr",
          countries: ["in"],
          // pp_razorpay_razorpay is derived from the provider `id: "razorpay"` set
          // in medusa-config.ts. pp_system_default backs Cash on Delivery, which
          // the frontend's checkout handles as an application-level branch rather
          // than a real payment capture.
          payment_providers: ["pp_razorpay_razorpay", "pp_system_default"],
        },
      ],
    },
  });

  await createTaxRegionsWorkflow(container).run({
    input: [{ country_code: "in", provider_id: "tp_system" }],
  });

  logger.info("Seeding warehouse and shipping...");
  const {
    result: [stockLocation],
  } = await createStockLocationsWorkflow(container).run({
    input: {
      locations: [
        {
          name: "EYRA Warehouse",
          address: { city: "Mumbai", country_code: "IN", address_1: "" },
        },
      ],
    },
  });

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  });

  // Created by a core migration — every fresh Medusa install has exactly one.
  const { data: shippingProfileResult } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  let shippingProfile = shippingProfileResult[0];
  if (!shippingProfile) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default", type: "default" }] },
    });
    shippingProfile = result[0];
  }

  const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
    name: "India delivery",
    type: "shipping",
    service_zones: [
      { name: "India", geo_zones: [{ country_code: "in", type: "country" }] },
    ],
  });

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  });

  // NOTE: this is a placeholder ₹0 flat rate so checkout has a valid shipping
  // method to select. Real delivery pricing/rules (free-above-threshold, etc.)
  // still needs to be decided and wired up — see the seed script's summary.
  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard Shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: shippingProfile.id,
        type: { label: "Standard", description: "Ship in 5-7 days.", code: "standard" },
        prices: [{ currency_code: "inr", amount: 0 }, { region_id: region.id, amount: 0 }],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  });

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocation.id, add: [salesChannel.id] },
  });

  logger.info("Seeding product types and tags...");
  const { result: typeResult } = await createProductTypesWorkflow(container).run({
    input: { product_types: [{ value: "ring" }, { value: "chain" }] },
  });
  const typeIdByValue = new Map(typeResult.map((t) => [t.value, t.id]));

  const { result: tagResult } = await createProductTagsWorkflow(container).run({
    input: { product_tags: ALL_SPECS.map((value) => ({ value })) },
  });
  const tagIdByValue = new Map(tagResult.map((t) => [t.value, t.id]));

  logger.info(`Seeding ${PRODUCTS.length} EYRA products...`);

  const productsInput = PRODUCTS.map((p) => {
    const isRing = p.type === "ring";
    const images = p.images.map((filename) => ({ url: `${IMG_BASE}/${filename}` }));

    const options = isRing
      ? [{ title: "Size", values: RING_SIZES.map(String) }]
      : [{ title: "Title", values: ["Default Title"] }];

    // Actual stock quantities are assigned in the inventory-seeding pass
    // below (stockBySku), computed independently from the same handle/SKU.
    const variants = isRing
      ? RING_SIZES.map((size) => ({
          title: `Size ${size}`,
          sku: `${p.handle}-${size}`,
          manage_inventory: true,
          options: { Size: String(size) },
          prices: [{ amount: p.price, currency_code: "inr" }],
        }))
      : [
          {
            title: "Default Title",
            sku: p.handle,
            manage_inventory: true,
            options: { Title: "Default Title" },
            prices: [{ amount: p.price, currency_code: "inr" }],
          },
        ];

    return {
      title: p.name,
      handle: p.handle,
      description: p.description,
      status: ProductStatus.PUBLISHED,
      type_id: typeIdByValue.get(p.type),
      tag_ids: specsFor(p.type).map((s) => tagIdByValue.get(s)!),
      thumbnail: images[0].url,
      images,
      weight: TYPE_WEIGHT_G[p.type],
      metadata: { rating: p.rating, review_count: p.reviewCount },
      shipping_profile_id: shippingProfile.id,
      sales_channels: [{ id: salesChannel.id }],
      options,
      variants,
    };
  });

  await createProductsWorkflow(container).run({ input: { products: productsInput } });

  logger.info("Seeding inventory levels...");

  // SKUs are deterministic (handle, or handle-size for rings), so map straight
  // back to each variant's intended stock without a second product lookup.
  const stockBySku = new Map<string, number>();
  for (const p of PRODUCTS) {
    const isRing = p.type === "ring";
    const variantCount = isRing ? RING_SIZES.length : 1;
    const stockPerVariant = distributeStock(p.inStock, variantCount);
    if (isRing) {
      RING_SIZES.forEach((size, i) => stockBySku.set(`${p.handle}-${size}`, stockPerVariant[i]));
    } else {
      stockBySku.set(p.handle, stockPerVariant[0]);
    }
  }

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
  });

  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: inventoryItems.map((item: { id: string; sku: string | null }) => ({
        location_id: stockLocation.id,
        inventory_item_id: item.id,
        stocked_quantity: (item.sku ? stockBySku.get(item.sku) : undefined) ?? 0,
      })),
    },
  });

  logger.info("EYRA seed complete.");
}
