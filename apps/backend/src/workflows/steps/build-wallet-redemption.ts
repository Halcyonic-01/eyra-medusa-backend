import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import {
  allocateFromLots,
  listSpendableLots,
  sumLots,
  type LotAllocation,
} from "../../modules/wallet/lots"
import type WalletModuleService from "../../modules/wallet/service"
import { redemptionReference, roundMoney } from "../../modules/wallet/utils"
import type { CreateWalletTransactionInput } from "./create-wallet-transaction"
import type { WalletSnapshot } from "./get-wallet"

type Input = {
  order_id: string
  amount: number
  wallet: WalletSnapshot | null
}

export type WalletRedemption = {
  /** True when this order was already redeemed, so nothing more is done. */
  skip: boolean
  transaction: CreateWalletTransactionInput | null
  new_balance: number
  /** Which credit batches the order spends from, and how much of each. */
  allocations: LotAllocation[]
}

const NOTHING: WalletRedemption = { skip: true, transaction: null, new_balance: 0, allocations: [] }

/**
 * Turns the wallet credit used on an order into the ledger row, the batches it
 * spends from and the new balance. Runs while the wallet lock is held, so the
 * batches read here are the ones that will be written. An order that was
 * already redeemed is skipped, which keeps a retried workflow from deducting
 * the credit twice.
 */
export const buildWalletRedemptionStep = createStep(
  "build-wallet-redemption",
  async (input: Input, { container }) => {
    // An order that used no wallet credit has nothing to redeem.
    if (input.amount <= 0) {
      return new StepResponse(NOTHING)
    }

    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    const reference = redemptionReference(input.order_id)

    const [alreadyRedeemed] = await walletService.listWalletTransactions(
      { reference },
      { take: 1 }
    )
    if (alreadyRedeemed) {
      return new StepResponse(NOTHING)
    }

    const wallet = input.wallet
    if (!wallet) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Wallet was not found")
    }

    const lots = await listSpendableLots(walletService, wallet.id)
    const allocations = allocateFromLots(lots, input.amount)
    if (!allocations) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Wallet ${wallet.id} has ${sumLots(lots)} spendable but order ${input.order_id} used ${input.amount}`
      )
    }

    const newBalance = roundMoney(sumLots(lots) - input.amount)
    const redemption: WalletRedemption = {
      skip: false,
      new_balance: newBalance,
      allocations,
      transaction: {
        wallet_id: wallet.id,
        type: "redeemed",
        amount: input.amount,
        balance_after: newBalance,
        order_id: input.order_id,
        reference,
        metadata: { allocations },
      },
    }

    return new StepResponse(redemption)
  }
)
