import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { recomputeProductRatings } from "../workflows/steps/review-submissions"

/**
 * Sets every product's rating and review count from its approved customer
 * reviews, and nothing else. Products with none show no rating. Run once after
 * deploying reviews, to clear the made-up numbers the old seed data wrote:
 *
 *   npx medusa exec ./src/scripts/reset-product-ratings.ts
 *
 * Safe to run again at any time.
 */
export default async function resetProductRatings({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const products = container.resolve(Modules.PRODUCT)
  let offset = 0
  let changed = 0
  for (;;) {
    const page = await products.listProducts({}, { select: ["id"], skip: offset, take: 100 })
    if (!page.length) break
    const result = await recomputeProductRatings(container, page.map((product) => product.id))
    changed += Object.keys(result).length
    offset += page.length
  }
  logger.info(`[reviews] ratings reset from approved reviews on ${changed} products`)
}
