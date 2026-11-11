import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, ProductVariantWorkflowEvents, ProductWorkflowEvents } from "@medusajs/framework/utils"
import { syncAnkletPairWorkflow } from "../workflows/sync-anklet-pair"

/**
 * After an anklet or one of its variants is created or changed in the admin,
 * makes sure it sells as Single or Pair with the Pair price derived from the Single.
 */
export default async function syncAnkletPairHandler({ event, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const id = event.data?.id
  if (!id) return

  let productId = id
  if (event.name.startsWith("product-variant.")) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "product_variant", fields: ["product_id"], filters: { id } })
    if (!data[0]?.product_id) return
    productId = data[0].product_id
  }

  try {
    const { result } = await syncAnkletPairWorkflow(container).run({ input: { product_id: productId } })
    if (result.status === "updated") {
      logger.info(`[anklet-pair] ${productId}: ${JSON.stringify(result)}`)
    } else if (result.status === "skipped" && result.reason !== "not an anklet") {
      logger.warn(`[anklet-pair] ${productId} left as it is: ${result.reason}`)
    }
  } catch (err) {
    logger.error(`[anklet-pair] ${productId}: ${(err as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: [
    ProductWorkflowEvents.CREATED,
    ProductWorkflowEvents.UPDATED,
    ProductVariantWorkflowEvents.CREATED,
    ProductVariantWorkflowEvents.UPDATED,
  ],
}
