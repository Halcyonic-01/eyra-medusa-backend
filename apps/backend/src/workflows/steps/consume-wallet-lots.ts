import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type { LotAllocation } from "../../modules/wallet/lots"
import type WalletModuleService from "../../modules/wallet/service"
import { roundMoney } from "../../modules/wallet/utils"

type Input = {
  allocations: LotAllocation[]
}

/** Takes the allocated amounts out of the credit batches. */
export const consumeWalletLotsStep = createStep(
  "consume-wallet-lots",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    await walletService.updateWalletTransactions(
      input.allocations.map((allocation) => ({
        id: allocation.lot_id,
        remaining: roundMoney(allocation.previous_remaining - allocation.amount),
      }))
    )

    return new StepResponse(input.allocations, input.allocations)
  },
  async (allocations, { container }) => {
    if (!allocations?.length) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.updateWalletTransactions(
      allocations.map((allocation) => ({
        id: allocation.lot_id,
        remaining: allocation.previous_remaining,
      }))
    )
  }
)
