import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { redeemWalletForOrderWorkflow } from "../workflows/redeem-wallet-for-order"

/**
 * When an order is placed, deduct any wallet credit it used. The workflow is
 * idempotent, so a repeated event cannot deduct the credit twice.
 */
export default async function redeemWalletCreditHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const { result } = await redeemWalletForOrderWorkflow(container).run({
      input: { order_id: data.id },
    })
    if (result.redeemed) {
      logger.info(`[wallet] redeemed ${result.amount} for order ${data.id}`)
    }
  } catch (error) {
    // Never block order placement on bookkeeping, but make it loud: an order
    // whose credit was not deducted needs a manual fix.
    logger.error(
      `[wallet] could not redeem wallet credit for order ${data.id}: ${(error as Error).message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
