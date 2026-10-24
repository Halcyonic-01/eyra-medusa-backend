import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createTaxRatesWorkflow,
  createTaxRegionsWorkflow,
  updateRegionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { COD_OPTION_CODE } from "./commerce-rules"
import { codGstRate, goodsGstRate, goodsHsn, serviceSac } from "./tax-config"

export const GOODS_TAX_RATE_CODE = "GST-HSN-7113"
export const SERVICE_TAX_RATE_CODE = "GST-SAC-9997"

/**
 * Records the GST rates in Medusa's tax module: the jewellery rate (3%, HSN
 * 7113) as the region's default, and the service rate (18%, SAC 9997, for the
 * Cash on Delivery charge) as an override for the Cash on Delivery shipping
 * option.
 *
 * They are records for the admin and for reports. They are deliberately NOT
 * applied to cart totals: prices include GST, and Medusa would then report the
 * item subtotal without tax, which the discount thresholds read. So each
 * region is told not to add taxes automatically, and the invoice and credit
 * note work the tax out from the inclusive amounts (gst-math.ts). Safe to run
 * again: it only adds what is missing.
 */
export async function setupTaxRates(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "automatic_taxes", "countries.iso_2"],
  })
  const countryCodes = new Set<string>()
  for (const region of regions) {
    for (const country of region.countries ?? []) {
      if (country?.iso_2) countryCodes.add(String(country.iso_2).toLowerCase())
    }
    if (region.automatic_taxes) {
      await updateRegionsWorkflow(container).run({
        input: { selector: { id: region.id as string }, update: { automatic_taxes: false } },
      })
      logger.info(`Region ${region.id}: automatic taxes switched off (prices already include GST)`)
    }
  }
  if (!countryCodes.size) countryCodes.add("in")

  for (const countryCode of countryCodes) {
    const { data: found } = await query.graph({
      entity: "tax_region",
      fields: ["id", "tax_rates.code"],
      filters: { country_code: countryCode },
    })
    let taxRegion = found[0]
    if (!taxRegion) {
      const { result } = await createTaxRegionsWorkflow(container).run({
        input: [{ country_code: countryCode, provider_id: "tp_system" }],
      })
      taxRegion = { id: result[0].id, tax_rates: [] } as unknown as (typeof found)[number]
    }
    const have = new Set((taxRegion.tax_rates ?? []).map((rate) => rate?.code))

    const { data: options } = await query.graph({
      entity: "shipping_option",
      fields: ["id", "type.code"],
    })
    const codOptionId = options.find((option) => option.type?.code === COD_OPTION_CODE)?.id as string | undefined

    const toCreate: {
      tax_region_id: string
      name: string
      code: string
      rate: number
      is_default: boolean
      rules?: { reference: string; reference_id: string }[]
    }[] = []
    if (!have.has(GOODS_TAX_RATE_CODE)) {
      toCreate.push({
        tax_region_id: taxRegion.id as string,
        name: `GST (HSN ${goodsHsn()})`,
        code: GOODS_TAX_RATE_CODE,
        rate: goodsGstRate(),
        is_default: true,
      })
    }
    if (!have.has(SERVICE_TAX_RATE_CODE)) {
      toCreate.push({
        tax_region_id: taxRegion.id as string,
        name: `GST (SAC ${serviceSac()})`,
        code: SERVICE_TAX_RATE_CODE,
        rate: codGstRate(),
        is_default: false,
        rules: codOptionId ? [{ reference: "shipping_option", reference_id: codOptionId }] : [],
      })
    }
    if (toCreate.length) {
      await createTaxRatesWorkflow(container).run({ input: toCreate })
      logger.info(`Tax region ${countryCode}: created ${toCreate.map((rate) => rate.code).join(", ")}`)
    } else {
      logger.info(`Tax region ${countryCode}: GST rates already set`)
    }
  }
}
