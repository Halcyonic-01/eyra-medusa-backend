import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { spendableBalance } from "../../modules/wallet/lots"

export type WalletSnapshot = {
  id: string
  customer_id: string
  currency_code: string
  /** Credit that can be spent right now: unexpired batches only. */
  balance: number
}

type GetWalletInput = {
  id?: string | null
  customer_id?: string | null
}

/** Read-only lookup. Returns null when the customer has no wallet yet. */
export const getWalletStep = createStep(
  "get-wallet",
  async (input: GetWalletInput, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    // Nothing to look up (for example an order that used no wallet credit).
    if (!input.id && !input.customer_id) {
      return new StepResponse<WalletSnapshot | null>(null)
    }

    const filters = input.id ? { id: input.id } : { customer_id: input.customer_id as string }
    const [wallet] = await walletService.listWallets(filters, { take: 1 })

    const snapshot: WalletSnapshot | null = wallet
      ? {
          id: wallet.id,
          customer_id: wallet.customer_id,
          currency_code: wallet.currency_code,
          balance: await spendableBalance(walletService, wallet.id),
        }
      : null

    return new StepResponse(snapshot)
  }
)
