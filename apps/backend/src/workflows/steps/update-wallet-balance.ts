import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { toNumber } from "../../modules/wallet/utils"

type Input = {
  wallet_id: string
  balance: number
}

type Compensation = {
  wallet_id: string
  previous_balance: number
}

/** Sets the wallet balance. Call it while holding the wallet lock. */
export const updateWalletBalanceStep = createStep(
  "update-wallet-balance",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    const before = await walletService.retrieveWallet(input.wallet_id)
    await walletService.updateWallets({
      id: input.wallet_id,
      balance: input.balance,
    })

    const compensation: Compensation = {
      wallet_id: input.wallet_id,
      previous_balance: toNumber(before.balance),
    }

    return new StepResponse({ wallet_id: input.wallet_id, balance: input.balance }, compensation)
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.updateWallets({
      id: compensation.wallet_id,
      balance: compensation.previous_balance,
    })
  }
)
