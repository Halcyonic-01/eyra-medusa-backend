import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { isAnkletType } from "../utils/anklet-pair"
import { syncAnkletPairWorkflow } from "../workflows/sync-anklet-pair"

/**
 * Gives every existing anklet its Single and Pair variants, with the Pair at two
 * singles less ₹200. New and edited anklets are kept right by the
 * sync-anklet-pair subscriber; this is for the ones created before it. Safe to
 * run again. Run with:
 *
 *   npx medusa exec ./src/scripts/sync-anklet-pairs.ts
 */
export default async function syncAnkletPairs({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({ entity: "product", fields: ["id", "handle", "type.value"] })
  const anklets = products.filter((product) => isAnkletType(product.type?.value))

  for (const product of anklets) {
    try {
      const { result } = await syncAnkletPairWorkflow(container).run({ input: { product_id: product.id } })
      logger.info(`[anklet-pair] ${product.handle}: ${JSON.stringify(result)}`)
    } catch (err) {
      logger.error(`[anklet-pair] ${product.handle}: ${(err as Error).message}`)
    }
  }
  logger.info(`[anklet-pair] checked ${anklets.length} anklet(s)`)
}
