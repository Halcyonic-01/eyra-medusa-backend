import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { spendableBalance } from "../../modules/wallet/lots"
import type { WalletSnapshot } from "./get-wallet"

type Input = {
  customer_id: string
}

type Compensation = {
  created_wallet_id: string | null
}

/**
 * Returns the customer's wallet, creating an empty one on first use.
 * Safe to retry: a second run finds the wallet the first run created.
 */
export const getOrCreateWalletStep = createStep(
  "get-or-create-wallet",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    const [existing] = await walletService.listWallets(
      { customer_id: input.customer_id },
      { take: 1 }
    )

    const wallet = existing ?? (await walletService.createWallets({
      customer_id: input.customer_id,
      balance: 0,
    }))

    const snapshot: WalletSnapshot = {
      id: wallet.id,
      customer_id: wallet.customer_id,
      currency_code: wallet.currency_code,
      balance: await spendableBalance(walletService, wallet.id),
    }
    const compensation: Compensation = {
      created_wallet_id: existing ? null : wallet.id,
    }

    return new StepResponse(snapshot, compensation)
  },
  async (compensation, { container }) => {
    if (!compensation?.created_wallet_id) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.deleteWallets(compensation.created_wallet_id)
  }
)
