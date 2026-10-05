import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"

type Input = {
  lots: { id: string; remaining: number }[]
}

/** Empties expired credit batches, so they can never be spent or counted again. */
export const zeroWalletLotsStep = createStep(
  "zero-wallet-lots",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    await walletService.updateWalletTransactions(
      input.lots.map((lot) => ({ id: lot.id, remaining: 0 }))
    )

    return new StepResponse(input.lots, input.lots)
  },
  async (lots, { container }) => {
    if (!lots?.length) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.updateWalletTransactions(
      lots.map((lot) => ({ id: lot.id, remaining: lot.remaining }))
    )
  }
)
