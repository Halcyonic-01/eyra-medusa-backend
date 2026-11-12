import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncAllAnkletPairs } from "../utils/sync-all-anklet-pairs"

/**
 * Every minute: makes sure each anklet sells as Single or Pair, with the Pair
 * priced from the Single (its sale prices too) and drawing two of its stock.
 * Sets up anklets that existed before this and follows sale price changes,
 * which raise no event the product subscriber could hear. Anklets already
 * right are only read.
 */
export default async function syncAnkletPairsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const { problems } = await syncAllAnkletPairs(container)
    // Say which anklets could not be set up when that changes, not every run.
    const key = problems.join("; ")
    if (key && key !== lastProblems) {
      logger.warn(`[anklet-pair] left as they are: ${key}`)
    }
    lastProblems = key
  } catch (err) {
    logger.error(`[anklet-pair] sync job failed: ${(err as Error).message}`)
  }
}

let lastProblems = ""

export const config = {
  name: "sync-anklet-pairs",
  schedule: "* * * * *",
}
