import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { WALLET_MODULE } from "../modules/wallet"
import type WalletModuleService from "../modules/wallet/service"
import { expireWalletCreditWorkflow } from "../workflows/expire-wallet-credit"

/**
 * Daily: retire wallet credit that has passed its expiry date. Customers can
 * never spend expired credit whether or not this has run yet; the job keeps the
 * ledger and stored balances up to date.
 */
export default async function expireWalletCreditJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

  const due = await walletService.listWalletTransactions({
    type: ["issued", "refunded"],
    remaining: { $gt: 0 },
    expires_at: { $lte: new Date() },
  })
  const walletIds = [...new Set(due.map((row) => (row as { wallet_id: string }).wallet_id))]

  let retired = 0
  for (const walletId of walletIds) {
    try {
      const { result } = await expireWalletCreditWorkflow(container).run({
        input: { wallet_id: walletId },
      })
      retired += result.expired_batches
    } catch (error) {
      logger.error(`[wallet] could not expire credit for ${walletId}: ${(error as Error).message}`)
    }
  }

  if (retired > 0) {
    logger.info(`[wallet] expired ${retired} credit batch(es) across ${walletIds.length} wallet(s)`)
  }
}

export const config = {
  name: "expire-wallet-credit",
  schedule: "0 2 * * *",
}
