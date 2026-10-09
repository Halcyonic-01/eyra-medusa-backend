import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { creditExpiry } from "../modules/wallet/config"
import { cancellationRefundReference, roundMoney } from "../modules/wallet/utils"
import { createWalletTransactionStep } from "./steps/create-wallet-transaction"
import { getOrCreateWalletStep } from "./steps/get-or-create-wallet"
import { updateWalletBalanceStep } from "./steps/update-wallet-balance"

export type CreditWalletForCancellationInput = {
  order_id: string
  customer_id: string
  /** What the customer paid online and chose to have refunded as wallet credit. */
  amount: number
}

/**
 * Adds the refund of a cancelled order to the customer's wallet, as a credit
 * batch with a full validity period. Idempotent: an order is credited once, so
 * a retry can never pay twice. Does not email; the cancellation email says it.
 */
export const creditWalletForCancellationWorkflow = createWorkflow(
  "credit-wallet-for-cancellation",
  function (input: CreditWalletForCancellationInput) {
    const lockKey = transform({ input }, (data) => `wallet:${data.input.customer_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const wallet = getOrCreateWalletStep(
      transform({ input }, (data) => ({ customer_id: data.input.customer_id }))
    )

    const transaction = createWalletTransactionStep(
      transform({ input, wallet }, (data) => {
        const amount = roundMoney(data.input.amount)
        return {
          wallet_id: data.wallet.id,
          type: "refunded" as const,
          reason: "cancellation" as const,
          amount,
          balance_after: roundMoney(data.wallet.balance + amount),
          remaining: amount,
          expires_at: creditExpiry(new Date()),
          order_id: data.input.order_id,
          reference: cancellationRefundReference(data.input.order_id),
          note: "Order cancelled, refunded to wallet",
        }
      })
    )

    // A repeat run finds the credit already there and must not touch the balance.
    when("credit-is-new", transaction, (data) => !data.already_recorded).then(() => {
      updateWalletBalanceStep(
        transform({ wallet, transaction }, (data) => ({
          wallet_id: data.wallet.id,
          balance: data.transaction.balance_after,
        }))
      )
    })

    releaseLockStep({ key: lockKey })

    const result = transform({ wallet, transaction }, (data) => ({
      wallet_id: data.wallet.id,
      transaction_id: data.transaction.id,
      balance: data.transaction.balance_after,
      expires_at: data.transaction.expires_at,
      already_recorded: data.transaction.already_recorded,
    }))

    return new WorkflowResponse(result)
  }
)
