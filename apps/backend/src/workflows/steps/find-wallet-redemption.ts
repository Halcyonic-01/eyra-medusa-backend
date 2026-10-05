import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { WALLET_MODULE } from "../../modules/wallet"
import type WalletModuleService from "../../modules/wallet/service"
import { redemptionReference, refundReference, toNumber } from "../../modules/wallet/utils"

type Input = {
  order_id: string
}

export type WalletRedemptionLookup = {
  found: boolean
  wallet_id: string | null
  /** What the order spent from the wallet. */
  amount: number
  /** True when that credit was already given back. */
  already_refunded: boolean
}

/** Looks up what an order spent from a wallet, and whether it was given back. */
export const findWalletRedemptionStep = createStep(
  "find-wallet-redemption",
  async (input: Input, { container }) => {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

    const [redeemed] = await walletService.listWalletTransactions(
      { reference: redemptionReference(input.order_id) },
      { take: 1 }
    )
    if (!redeemed) {
      const none: WalletRedemptionLookup = {
        found: false,
        wallet_id: null,
        amount: 0,
        already_refunded: false,
      }
      return new StepResponse(none)
    }

    const [refund] = await walletService.listWalletTransactions(
      { reference: refundReference(input.order_id) },
      { take: 1 }
    )

    const lookup: WalletRedemptionLookup = {
      found: true,
      wallet_id: (redeemed as { wallet_id: string }).wallet_id,
      amount: toNumber(redeemed.amount),
      already_refunded: Boolean(refund),
    }
    return new StepResponse(lookup)
  }
)
