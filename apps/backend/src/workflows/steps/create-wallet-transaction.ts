import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { toNumber } from "../../modules/wallet/utils"

export type CreateWalletTransactionInput = {
  wallet_id: string
  type: "issued" | "redeemed" | "refunded" | "expired"
  reason?: "return" | "exchange" | "cancellation" | null
  amount: number
  balance_after: number
  /** Credit rows: the unspent part, equal to the amount when first created. */
  remaining?: number
  /** Credit rows: when the batch stops being usable; null means never. */
  expires_at?: Date | null
  metadata?: Record<string, unknown> | null
  order_id?: string | null
  reference?: string | null
  note?: string | null
  created_by?: string | null
}

export type WalletTransactionRecord = {
  id: string
  wallet_id: string
  type: "issued" | "redeemed" | "refunded" | "expired"
  reason: "return" | "exchange" | "cancellation" | null
  amount: number
  balance_after: number
  remaining: number
  expires_at: string | null
  order_id: string | null
  reference: string | null
  note: string | null
  created_by: string | null
  already_recorded: boolean
}

type Compensation = {
  created_transaction_id: string | null
}

/**
 * Appends one row to the ledger. When a `reference` is given and a row with
 * that reference already exists, that row is returned and nothing is written,
 * which is what makes a retried redemption harmless.
 */
export const createWalletTransactionStep = createStep(
  "create-wallet-transaction",
  async (input: CreateWalletTransactionInput, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    let existing: Awaited<ReturnType<WalletModuleService["listWalletTransactions"]>>[number] | undefined
    if (input.reference) {
      ;[existing] = await walletService.listWalletTransactions(
        { reference: input.reference },
        { take: 1 }
      )
    }

    const row = existing ?? (await walletService.createWalletTransactions({
      wallet_id: input.wallet_id,
      type: input.type,
      reason: input.reason ?? null,
      amount: input.amount,
      balance_after: input.balance_after,
      remaining: input.remaining ?? 0,
      expires_at: input.expires_at ?? null,
      metadata: input.metadata ?? null,
      order_id: input.order_id ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      created_by: input.created_by ?? null,
    }))

    const record: WalletTransactionRecord = {
      id: row.id,
      wallet_id: input.wallet_id,
      type: row.type,
      reason: row.reason ?? null,
      amount: toNumber(row.amount),
      balance_after: toNumber(row.balance_after),
      remaining: toNumber(row.remaining),
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      order_id: row.order_id ?? null,
      reference: row.reference ?? null,
      note: row.note ?? null,
      created_by: row.created_by ?? null,
      already_recorded: Boolean(existing),
    }
    const compensation: Compensation = {
      created_transaction_id: existing ? null : row.id,
    }

    return new StepResponse(record, compensation)
  },
  async (compensation, { container }) => {
    if (!compensation?.created_transaction_id) {
      return
    }
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    await walletService.deleteWalletTransactions(compensation.created_transaction_id)
  }
)
