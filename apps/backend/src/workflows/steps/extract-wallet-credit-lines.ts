import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_CREDIT_LINE_REFERENCE, toNumber } from "../../modules/wallet/utils"

type CreditLine = {
  id: string
  amount: unknown
  reference?: string | null
  reference_id?: string | null
}

type WalletRecord = {
  id: string
  completed_at?: string | null
  credit_lines?: CreditLine[] | null
}

type Input = {
  /** Open cart to inspect, or a placed order when `allow_completed` is set. */
  // Query results are loosely typed, so they are narrowed to WalletRecord below.
  records: unknown[]
  allow_completed?: boolean
}

export type WalletCreditLines = {
  ids: string[]
  /** Wallet that funded the lines, taken from the lines' reference_id. */
  wallet_id: string | null
  amount: number
}

/** Picks the wallet-funded credit lines out of a cart or order. */
export const extractWalletCreditLinesStep = createStep(
  "extract-wallet-credit-lines",
  async (input: Input) => {
    const record = input.records[0] as WalletRecord | undefined
    if (!record) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Record was not found")
    }
    if (record.completed_at && !input.allow_completed) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart has already been completed"
      )
    }

    const lines = (record.credit_lines ?? []).filter(
      (line) => line.reference === WALLET_CREDIT_LINE_REFERENCE
    )

    const result: WalletCreditLines = {
      ids: lines.map((line) => line.id),
      wallet_id: lines.find((line) => line.reference_id)?.reference_id ?? null,
      amount: lines.reduce((sum, line) => sum + toNumber(line.amount), 0),
    }

    return new StepResponse(result)
  }
)
