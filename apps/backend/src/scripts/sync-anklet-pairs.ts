import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncAllAnkletPairs } from "../utils/sync-all-anklet-pairs"

/**
 * Gives every anklet its Single and Pair variants, with the Pair at two singles
 * less ₹200 (sale prices too) and drawing two of the Single's stock. The
 * sync-anklet-pairs job does the same every minute, so this is only needed to do
 * it straight away. Safe to run again. Run with:
 *
 *   npx medusa exec ./src/scripts/sync-anklet-pairs.ts
 */
export default async function syncAnkletPairs({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const sweep = await syncAllAnkletPairs(container, true)
  logger.info(`[anklet-pair] checked ${sweep.checked} anklet(s), updated ${sweep.updated}, left ${sweep.problems.length}`)
}
