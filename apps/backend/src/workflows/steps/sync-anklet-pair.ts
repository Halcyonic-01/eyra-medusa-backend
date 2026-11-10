import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  createProductVariantsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"
import { planPairSync, type PairProduct, type PairVariant } from "../../utils/anklet-pair"

export type AnkletPairStatus =
  | { status: "skipped"; reason: string }
  | { status: "in_sync" }
  | { status: "updated"; restructured: boolean; created_pair: boolean; repriced: boolean }

type Row = {
  id: string
  type?: { value?: string | null } | null
  options?: { title: string; values?: { value: string }[] }[]
  variants?: {
    id: string
    title?: string | null
    sku?: string | null
    manage_inventory?: boolean | null
    options?: { value: string; option?: { title: string } | null }[]
    prices?: { id: string; amount: number | string; currency_code: string; price_list_id?: string | null; rules_count?: number | null }[]
    inventory_items?: { inventory_item_id: string; required_quantity: number | string }[]
  }[]
}

/** Loads an anklet in the shape planPairSync reads. Null when it does not exist. */
export async function loadPairProduct(container: MedusaContainer, productId: string): Promise<PairProduct | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "type.value",
      "options.title",
      "options.values.value",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.manage_inventory",
      "variants.options.value",
      "variants.options.option.title",
      "variants.prices.id",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.prices.price_list_id",
      "variants.prices.rules_count",
      "variants.inventory_items.inventory_item_id",
      "variants.inventory_items.required_quantity",
    ],
    filters: { id: productId },
  })
  const row = data[0] as Row | undefined
  if (!row) return null

  const variants: PairVariant[] = (row.variants ?? []).map((variant) => {
    // The plain INR price: not from a price list, and with no rules such as a region.
    const inr = (variant.prices ?? []).find(
      (price) => price.currency_code === "inr" && !price.price_list_id && !Number(price.rules_count ?? 0)
    )
    return {
      id: variant.id,
      title: variant.title ?? null,
      sku: variant.sku ?? null,
      manage_inventory: Boolean(variant.manage_inventory),
      options: Object.fromEntries(
        (variant.options ?? [])
          .filter((value) => value.option?.title)
          .map((value) => [value.option!.title, value.value])
      ),
      inr: inr ? { id: inr.id, amount: Number(inr.amount) } : null,
      inventory: (variant.inventory_items ?? []).map((item) => ({
        inventory_item_id: item.inventory_item_id,
        required_quantity: Number(item.required_quantity) || 1,
      })),
    }
  })

  return {
    id: row.id,
    type: row.type?.value ?? null,
    options: (row.options ?? []).map((option) => ({
      title: option.title,
      values: (option.values ?? []).map((value) => value.value),
    })),
    variants,
  }
}

function failed(action: string, errors: unknown[]): never {
  const detail = errors
    .map((entry) => (entry as { error?: { message?: string } })?.error?.message ?? String(entry))
    .join("; ")
  throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `Could not ${action}: ${detail}`)
}

/**
 * Makes one anklet sell as Single or Pair: adds the Pack option and the Pair
 * variant if missing, and keeps the Pair at two singles less the pair discount.
 * Changes nothing when it is already right, so the events it causes are harmless.
 */
export const syncAnkletPairStep = createStep(
  "sync-anklet-pair",
  async (input: { product_id: string }, { container }) => {
    const product = await loadPairProduct(container, input.product_id)
    if (!product) return new StepResponse<AnkletPairStatus>({ status: "skipped", reason: "product not found" })

    const plan = planPairSync(product)
    if (plan.kind === "skip") return new StepResponse<AnkletPairStatus>({ status: "skipped", reason: plan.reason })
    if (plan.kind === "in_sync") return new StepResponse<AnkletPairStatus>({ status: "in_sync" })

    if (plan.restructure) {
      const { errors } = await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: product.id,
              options: plan.restructure.options,
              variants: [plan.restructure.single],
            },
          ],
        },
        throwOnError: false,
      })
      if (errors.length) failed("add the Pack option", errors)
    }

    if (plan.createPair) {
      const { errors } = await createProductVariantsWorkflow(container).run({
        input: { product_variants: [plan.createPair] },
        throwOnError: false,
      })
      if (errors.length) failed("create the Pair variant", errors)
    }

    if (plan.reprice) {
      const price = {
        ...(plan.reprice.price_id ? { id: plan.reprice.price_id } : {}),
        amount: plan.reprice.amount,
        currency_code: "inr",
      }
      const { errors } = await updateProductVariantsWorkflow(container).run({
        input: { product_variants: [{ id: plan.reprice.variant_id, prices: [price] }] },
        throwOnError: false,
      })
      if (errors.length) failed("set the Pair price", errors)
    }

    return new StepResponse<AnkletPairStatus>({
      status: "updated",
      restructured: Boolean(plan.restructure),
      created_pair: Boolean(plan.createPair),
      repriced: Boolean(plan.reprice),
    })
  }
)
