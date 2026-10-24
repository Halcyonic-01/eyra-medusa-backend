import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { ProductStatus } from "@medusajs/framework/utils"
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createPromotionRulesWorkflow,
  createPromotionsWorkflow,
  createShippingOptionsWorkflow,
  deletePromotionRulesWorkflow,
  updatePromotionRulesWorkflow,
  updateShippingOptionsWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  COD_CHARGE,
  COD_OPTION_CODE,
  DISCOUNT_CODES,
  PREPAID_OPTION_CODE,
  TOTE_HANDLE,
  TOTE_SKU,
} from "./commerce-rules"
import { planIsEmpty, planPromotionRuleSync, type DesiredRule, type ExistingRule } from "./promotion-rules"
import { setupTaxRates } from "./setup-tax-rates"

/**
 * One-time (and safe to repeat) setup of the launch checkout rules:
 *
 *   - the two shipping options: complimentary shipping for prepaid orders and
 *     the Cash on Delivery charge,
 *   - the three discount codes, with WELCOME200 limited to once per customer,
 *   - the complimentary tote bag: a hidden product at a price of zero, whose
 *     stock is set in the admin (TOTE_INITIAL_STOCK sets the first count),
 *   - the GST rates as Medusa tax rates (see setup-tax-rates.ts).
 *
 * It only creates what is missing and never deletes anything. Run it once per
 * environment, through the script of the same name:
 *
 *   npx medusa exec ./src/scripts/setup-launch-commerce.ts
 *
 * Set DISABLE_OTHER_SHIPPING_OPTIONS=true to also switch off every other
 * shipping option in the store (the cart check refuses them anyway).
 */
export async function setupLaunchCommerce(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  /* ── Shipping options ─────────────────────────────────────────────── */

  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: [
      "id",
      "name",
      "service_zone_id",
      "shipping_profile_id",
      "provider_id",
      "type.code",
      "rules.id",
      "rules.attribute",
      "rules.value",
    ],
  })

  const existingCodes = new Set(options.map((option) => option.type?.code))
  const template = options.find((option) => option.service_zone_id && option.shipping_profile_id)
  if (!template) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "No existing shipping option to copy the delivery zone from. Run the seed first.")
  }

  const { data: regions } = await query.graph({ entity: "region", fields: ["id"] })
  const regionId = regions[0]?.id

  const wanted = [
    {
      code: PREPAID_OPTION_CODE,
      name: "Free shipping (prepaid)",
      label: "Prepaid",
      description: "Complimentary shipping on every prepaid order.",
      amount: 0,
    },
    {
      code: COD_OPTION_CODE,
      name: "Cash on Delivery",
      label: "Cash on Delivery",
      description: "Cash on Delivery charge.",
      amount: COD_CHARGE,
    },
  ]

  for (const entry of wanted) {
    if (existingCodes.has(entry.code)) {
      logger.info(`Shipping option ${entry.code} already exists`)
      continue
    }
    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: entry.name,
          price_type: "flat",
          provider_id: template.provider_id ?? "manual_manual",
          service_zone_id: template.service_zone_id!,
          shipping_profile_id: template.shipping_profile_id!,
          type: { label: entry.label, description: entry.description, code: entry.code },
          prices: [
            { currency_code: "inr", amount: entry.amount },
            ...(regionId ? [{ region_id: regionId, amount: entry.amount }] : []),
          ],
          rules: [
            { attribute: "enabled_in_store", value: "true", operator: "eq" },
            { attribute: "is_return", value: "false", operator: "eq" },
          ],
        },
      ],
    })
    logger.info(`Created shipping option ${entry.code} (${entry.amount === 0 ? "free" : `Rs ${entry.amount}`})`)
  }

  const ours = new Set([PREPAID_OPTION_CODE, COD_OPTION_CODE])
  const others = options.filter((option) => !ours.has(option.type?.code ?? ""))
  if (others.length) {
    if (process.env.DISABLE_OTHER_SHIPPING_OPTIONS === "true") {
      for (const option of others) {
        const rule = option.rules?.find((entry) => entry?.attribute === "enabled_in_store")
        if (!rule?.id) continue
        const switchOff = { id: rule.id, attribute: "enabled_in_store", operator: "eq" as const, value: "false" }
        await updateShippingOptionsWorkflow(container).run({
          input: [{ id: option.id, rules: [switchOff] }],
        })
        logger.info(`Switched off shipping option "${option.name}"`)
      }
    } else {
      logger.warn(
        `Other shipping options still exist (${others.map((option) => option.name).join(", ")}). ` +
          "Checkout ignores them, but switch them off in the admin, or rerun with DISABLE_OTHER_SHIPPING_OPTIONS=true."
      )
    }
  }

  /* ── Discount codes ───────────────────────────────────────────────── */

  const { data: promotions } = await query.graph({
    entity: "promotion",
    fields: ["id", "code", "rules.id", "rules.attribute", "rules.operator", "rules.values.value"],
    filters: { code: DISCOUNT_CODES.map((entry) => entry.code) },
  })
  const existingPromotions = new Map(promotions.map((promotion) => [promotion.code, promotion]))

  for (const entry of DISCOUNT_CODES) {
    // The order-value limit is a rule on the cart's item subtotal, which is the
    // price of the items before any discount and without shipping. Medusa
    // re-checks it on every cart change, so a code drops off by itself when the
    // cart no longer qualifies. There is only a minimum, no upper limit.
    const rules: DesiredRule[] = [
      {
        attribute: "item_subtotal",
        operator: entry.min.inclusive ? "gte" : "gt",
        values: [String(entry.min.value)],
      },
    ]

    const existing = existingPromotions.get(entry.code)
    if (existing) {
      // A code made by an earlier run keeps the rules it was made with, so bring them up to date.
      const plan = planPromotionRuleSync(rules, (existing.rules ?? []).filter(Boolean) as unknown as ExistingRule[])
      if (planIsEmpty(plan)) {
        logger.info(`Discount code ${entry.code} already exists and its rules are current`)
        continue
      }
      if (plan.remove.length) {
        await deletePromotionRulesWorkflow(container).run({
          input: { rule_type: "rules", data: { id: existing.id, rule_ids: plan.remove } },
        })
      }
      if (plan.update.length) {
        await updatePromotionRulesWorkflow(container).run({ input: { data: plan.update } })
      }
      if (plan.add.length) {
        await createPromotionRulesWorkflow(container).run({
          input: { rule_type: "rules", data: { id: existing.id, rules: plan.add } },
        })
      }
      logger.info(
        `Updated rules of ${entry.code}: removed ${plan.remove.length}, changed ${plan.update.length}, added ${plan.add.length}`
      )
      continue
    }

    await createPromotionsWorkflow(container).run({
      input: {
        promotionsData: [
          {
            code: entry.code,
            type: "standard",
            status: "active",
            is_automatic: false,
            rules,
            application_method: {
              type: "fixed",
              target_type: "order",
              allocation: "across",
              value: entry.amount,
              currency_code: "inr",
            },
            ...(entry.oncePerCustomer
              ? {
                  campaign: {
                    name: `${entry.code} (once per customer)`,
                    campaign_identifier: `${entry.code.toLowerCase()}-once-per-customer`,
                    budget: { type: "use_by_attribute", attribute: "customer_id", limit: 1 },
                  },
                }
              : {}),
          },
        ],
      },
    })
    logger.info(`Created discount code ${entry.code} (Rs ${entry.amount} off)`)
  }

  await setupTote(container, template.shipping_profile_id!)
  await setupTaxRates(container)

  logger.info("Launch commerce setup finished.")
}

/**
 * The complimentary tote bag: a product at a price of zero that never shows in
 * the shop. It carries stock, so it runs out like anything else ("subject to
 * stock availability"): an order that qualifies while it is out gets no tote.
 * It starts with TOTE_INITIAL_STOCK (default 0), so none is promised until the
 * team has set the real count in the admin under Inventory.
 */
async function setupTote(container: MedusaContainer, shippingProfileId: string) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: existing } = await query.graph({
    entity: "product",
    fields: ["id"],
    filters: { handle: TOTE_HANDLE },
  })
  if (existing.length) {
    logger.info("Complimentary tote product already exists")
    return
  }

  const { data: channels } = await query.graph({ entity: "sales_channel", fields: ["id"] })
  const { data: locations } = await query.graph({ entity: "stock_location", fields: ["id"] })

  await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "EYRA Tote Bag",
          handle: TOTE_HANDLE,
          description: "Complimentary with orders above ₹1,499, while stock lasts.",
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfileId,
          sales_channels: channels[0] ? [{ id: channels[0].id as string }] : [],
          // Medusa only lets a published product's variants into a cart, so the
          // shop is told to skip it by this flag instead.
          metadata: { hidden_from_shop: "true" },
          options: [{ title: "Default", values: ["Default"] }],
          variants: [
            {
              title: "Default",
              sku: TOTE_SKU,
              manage_inventory: true,
              allow_backorder: false,
              options: { Default: "Default" },
              prices: [{ currency_code: "inr", amount: 0 }],
            },
          ],
        },
      ],
    },
  })

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "inventory_items.inventory_item_id"],
    filters: { sku: TOTE_SKU },
  })
  const inventoryItemId = variants[0]?.inventory_items?.[0]?.inventory_item_id as string | undefined
  const rawStock = Number(process.env.TOTE_INITIAL_STOCK ?? 0)
  const stock = Number.isInteger(rawStock) && rawStock >= 0 ? rawStock : 0

  if (inventoryItemId && locations[0]) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: [
          { inventory_item_id: inventoryItemId, location_id: locations[0].id as string, stocked_quantity: stock },
        ],
      },
    })
  }
  logger.info(
    stock > 0
      ? `Created the complimentary tote (stock ${stock})`
      : "Created the complimentary tote with no stock: set the real count in the admin under Inventory, or no order gets one."
  )
}
