import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createExpiryTransactionsStep } from "./steps/create-expiry-transactions"
import { findExpiredLotsStep } from "./steps/find-expired-lots"
import { getWalletStep } from "./steps/get-wallet"
import { updateWalletBalanceStep } from "./steps/update-wallet-balance"
import { zeroWalletLotsStep } from "./steps/zero-wallet-lots"

export type ExpireWalletCreditInput = {
  wallet_id: string
}

/**
 * Retires one wallet's credit that has passed its expiry date: the batches are
 * emptied and each is recorded in the ledger. Spending already ignores expired
 * credit, so this keeps the ledger and stored balance honest, and is safe to
 * run any number of times.
 */
export const expireWalletCreditWorkflow = createWorkflow(
  "expire-wallet-credit",
  function (input: ExpireWalletCreditInput) {
    const lookup = getWalletStep({ id: input.wallet_id })

    const lockKey = transform({ lookup }, (data) => `wallet:${data.lookup?.customer_id ?? "none"}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const expired = findExpiredLotsStep({ wallet_id: input.wallet_id })

    when("has-expired-lots", expired, (data) => data.lots.length > 0).then(() => {
      zeroWalletLotsStep(transform({ expired }, (data) => ({ lots: data.expired.lots })))

      const wallet = getWalletStep({ id: input.wallet_id }).config({
        name: "get-wallet-after-expiry",
      })

      createExpiryTransactionsStep(
        transform({ input, expired, wallet }, (data) => ({
          wallet_id: data.input.wallet_id,
          balance_after: data.wallet!.balance,
          lots: data.expired.lots,
        }))
      )

      updateWalletBalanceStep(
        transform({ wallet }, (data) => ({
          wallet_id: data.wallet!.id,
          balance: data.wallet!.balance,
        }))
      )
    })

    releaseLockStep({ key: lockKey })

    const result = transform({ expired }, (data) => ({
      expired_batches: data.expired.lots.length,
      expired_amount: data.expired.lots.reduce((sum, lot) => sum + lot.remaining, 0),
    }))

    return new WorkflowResponse(result)
  }
)
