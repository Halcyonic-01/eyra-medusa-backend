import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { expiryReference } from "../../modules/wallet/utils"

type Input = {
  wallet_id: string
  /** Spendable balance. Expiry does not change it: expired credit was already excluded. */
  balance_after: number
  lots: { id: string; remaining: number; expires_at: string }[]
}

/** Writes one "expired" ledger row per batch. A batch is recorded at most once. */
export const createExpiryTransactionsStep = createStep(
  "create-expiry-transactions",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    const existing = await walletService.listWalletTransactions({
      reference: input.lots.map((lot) => expiryReference(lot.id)),
    })
    const recorded = new Set(existing.map((row) => row.reference))

    const fresh = input.lots.filter((lot) => !recorded.has(expiryReference(lot.id)))
    const created = fresh.length
      ? await walletService.createWalletTransactions(
          fresh.map((lot) => ({
            wallet_id: input.wallet_id,
            type: "expired" as const,
            amount: lot.remaining,
            balance_after: input.balance_after,
            reference: expiryReference(lot.id),
            note: `Credit expired on ${lot.expires_at.slice(0, 10)}`,
            metadata: { lot_id: lot.id },
          }))
        )
      : []

    return new StepResponse(created, created.map((row) => row.id))
  },
  async (ids, { container }) => {
    if (!ids?.length) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.deleteWalletTransactions(ids)
  }
)
