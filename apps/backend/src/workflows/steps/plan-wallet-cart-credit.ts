import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  WALLET_CREDIT_LINE_REFERENCE,
  roundMoney,
  toNumber,
} from "../../modules/wallet/utils"
import type { WalletSnapshot } from "./get-wallet"

type CartCreditLine = {
  id: string
  amount: unknown
  reference?: string | null
}

type CartSnapshot = {
  id: string
  email?: string | null
  customer_id?: string | null
  currency_code: string
  total: unknown
  completed_at?: string | null
  credit_lines?: CartCreditLine[] | null
}

type Input = {
  customer_id: string
  // Query results are loosely typed, so they are narrowed to CartSnapshot below.
  carts: unknown[]
  customers: { id: string; email?: string | null }[]
  wallet: WalletSnapshot | null
}

export type WalletCartPlan = {
  wallet_id: string
  /** Credit to put on the cart, in rupees. */
  amount: number
  /** What the cart would cost with no wallet credit at all. */
  cart_total_without_wallet: number
  wallet_balance: number
  /** Wallet credit lines already on the cart, replaced by the new one. */
  remove_ids: string[]
}

/**
 * Decides how much wallet credit a cart can take: the smaller of the
 * customer's balance and what the cart costs without any wallet credit.
 * Everything that must hold true before touching the cart is checked here.
 */
export const planWalletCartCreditStep = createStep(
  "plan-wallet-cart-credit",
  async (input: Input) => {
    const cart = input.carts[0] as CartSnapshot | undefined
    if (!cart) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart was not found")
    }
    if (cart.completed_at) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart has already been completed"
      )
    }

    const customer = input.customers[0]
    if (!customer) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Customer was not found")
    }
    if (cart.customer_id && cart.customer_id !== customer.id) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart belongs to a different customer"
      )
    }
    if (
      cart.email &&
      customer.email &&
      cart.email.trim().toLowerCase() !== customer.email.trim().toLowerCase()
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This cart belongs to a different customer"
      )
    }

    const wallet = input.wallet
    if (!wallet || wallet.balance <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "There is no wallet credit available to apply"
      )
    }
    if (wallet.currency_code.toLowerCase() !== cart.currency_code.toLowerCase()) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The wallet currency does not match the cart currency"
      )
    }

    const existing = (cart.credit_lines ?? []).filter(
      (line) => line.reference === WALLET_CREDIT_LINE_REFERENCE
    )
    const existingAmount = existing.reduce((sum, line) => sum + toNumber(line.amount), 0)

    // The cart total is already net of any wallet credit on it, so add that
    // back to get what the customer would owe with no credit applied.
    const withoutWallet = roundMoney(toNumber(cart.total) + existingAmount)
    // Whole rupees only: the storefront and Razorpay work in whole rupees, so
    // any paise in the wallet stay there for a later order.
    const amount = Math.floor(Math.min(wallet.balance, withoutWallet))
    if (amount <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "There is nothing left on this cart to pay with wallet credit"
      )
    }

    const plan: WalletCartPlan = {
      wallet_id: wallet.id,
      amount,
      cart_total_without_wallet: withoutWallet,
      wallet_balance: wallet.balance,
      remove_ids: existing.map((line) => line.id),
    }

    return new StepResponse(plan)
  }
)
