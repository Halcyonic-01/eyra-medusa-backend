import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import { listExpiredLots } from "../../modules/wallet/lots"
import type WalletModuleService from "../../modules/wallet/service"

type Input = {
  wallet_id: string
}

export type ExpiredLots = {
  lots: { id: string; remaining: number; expires_at: string }[]
}

/** Credit batches of one wallet that reached their expiry with credit left. */
export const findExpiredLotsStep = createStep(
  "find-expired-lots",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    const lots = await listExpiredLots(walletService, input.wallet_id)

    const result: ExpiredLots = {
      lots: lots.map((lot) => ({
        id: lot.id,
        remaining: lot.remaining,
        expires_at: (lot.expires_at as Date).toISOString(),
      })),
    }
    return new StepResponse(result)
  }
)
