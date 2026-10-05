import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refundWalletForOrderWorkflow } from "../workflows/refund-wallet-for-order"

/**
 * When an order is cancelled, give back any wallet credit it used. The workflow
 * is idempotent, so a repeated event cannot refund the credit twice.
 */
export default async function refundWalletCreditHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const { result } = await refundWalletForOrderWorkflow(container).run({
      input: { order_id: data.id },
    })
    if (result.refunded) {
      logger.info(`[wallet] returned ${result.amount} to the wallet for cancelled order ${data.id}`)
    }
  } catch (error) {
    // Never block a cancellation on bookkeeping, but make it loud: credit that
    // was not returned needs a manual fix.
    logger.error(
      `[wallet] could not return wallet credit for cancelled order ${data.id}: ${(error as Error).message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
