import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncAnkletPairWorkflow } from "../workflows/sync-anklet-pair"
import { isAnkletType, planPairSync } from "./anklet-pair"
import { loadPairProduct } from "../workflows/steps/sync-anklet-pair"

export type AnkletPairSweep = {
  checked: number
  updated: number
  /** Anklets left as they are, each with the reason. */
  problems: string[]
}

/**
 * Checks every anklet sells as Single or Pair, with the Pair at two singles less
 * ₹200 (sale prices included) and drawing two of the Single's stock. Anklets
 * already right are only read. Changes are logged; anklets that could not be set
 * up are returned, and logged too with `verbose`.
 */
export async function syncAllAnkletPairs(container: MedusaContainer, verbose = false): Promise<AnkletPairSweep> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({ entity: "product", fields: ["id", "handle", "type.value"] })
  const anklets = products.filter((product) => isAnkletType(product.type?.value))

  const sweep: AnkletPairSweep = { checked: anklets.length, updated: 0, problems: [] }
  for (const product of anklets) {
    try {
      // A read first, so an anklet that is already right costs no workflow run.
      const loaded = await loadPairProduct(container, product.id)
      const plan = loaded ? planPairSync(loaded) : null
      if (plan?.kind === "in_sync") {
        if (verbose) logger.info(`[anklet-pair] ${product.handle}: {"status":"in_sync"}`)
        continue
      }
      if (plan?.kind === "skip") {
        sweep.problems.push(`${product.handle} (${plan.reason})`)
        if (verbose) logger.warn(`[anklet-pair] ${product.handle} left as it is: ${plan.reason}`)
        continue
      }
      const { result } = await syncAnkletPairWorkflow(container).run({ input: { product_id: product.id } })
      if (result.status === "updated") {
        sweep.updated++
        logger.info(`[anklet-pair] ${product.handle}: ${JSON.stringify(result)}`)
      } else if (result.status === "skipped") {
        sweep.problems.push(`${product.handle} (${result.reason})`)
        if (verbose) logger.warn(`[anklet-pair] ${product.handle} left as it is: ${result.reason}`)
      } else if (verbose) {
        logger.info(`[anklet-pair] ${product.handle}: ${JSON.stringify(result)}`)
      }
    } catch (err) {
      sweep.problems.push(`${product.handle} (${(err as Error).message})`)
      if (verbose) logger.error(`[anklet-pair] ${product.handle}: ${(err as Error).message}`)
    }
  }
  return sweep
}
