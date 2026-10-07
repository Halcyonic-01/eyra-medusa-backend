import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  emitEventStep,
  releaseLockStep,
} from "@medusajs/medusa/core-flows"
import { creditExpiry } from "../modules/wallet/config"
import { refundReference, roundMoney } from "../modules/wallet/utils"
import { createWalletTransactionStep } from "./steps/create-wallet-transaction"
import { findWalletRedemptionStep } from "./steps/find-wallet-redemption"
import { getWalletStep } from "./steps/get-wallet"
import { updateWalletBalanceStep } from "./steps/update-wallet-balance"

export type RefundWalletForOrderInput = {
  order_id: string
  /** Set to false when another email already tells the customer, to avoid sending two. */
  notify?: boolean
}

/**
 * Gives back the wallet credit an order used, when that order is cancelled.
 * The credit comes back as a fresh batch with a full validity period, so a
 * cancellation never costs the customer credit that has lapsed in the meantime.
 * Idempotent: an order is refunded at most once, and an order that used no
 * wallet credit is left alone.
 */
export const refundWalletForOrderWorkflow = createWorkflow(
  "refund-wallet-for-order",
  function (input: RefundWalletForOrderInput) {
    const redemption = findWalletRedemptionStep({ order_id: input.order_id })

    const lookup = getWalletStep({ id: redemption.wallet_id })

    const lockKey = transform({ lookup }, (data) => `wallet:${data.lookup?.customer_id ?? "none"}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    // Read again now that the lock is held, so the balance is current.
    const wallet = getWalletStep({ id: redemption.wallet_id }).config({
      name: "get-wallet-locked",
    })

    const refunded = when(
      "should-refund",
      redemption,
      (data) => data.found && !data.already_refunded
    ).then(() => {
      const transaction = createWalletTransactionStep(
        transform({ input, redemption, wallet }, (data) => ({
          wallet_id: data.wallet!.id,
          type: "refunded" as const,
          reason: "cancellation" as const,
          amount: data.redemption.amount,
          balance_after: roundMoney(data.wallet!.balance + data.redemption.amount),
          remaining: data.redemption.amount,
          expires_at: creditExpiry(new Date()),
          order_id: data.input.order_id,
          reference: refundReference(data.input.order_id),
          note: "Order cancelled",
        }))
      )

      updateWalletBalanceStep(
        transform({ wallet, transaction }, (data) => ({
          wallet_id: data.wallet!.id,
          balance: data.transaction.balance_after,
        }))
      )

      return transaction
    })

    when(
      "announce-refund",
      { input, refunded },
      (data) => Boolean(data.refunded) && data.input.notify !== false
    ).then(() => {
      emitEventStep({
        eventName: "wallet.credit_added",
        data: transform({ input, wallet, refunded }, (data) => ({
          kind: "refunded",
          wallet_id: data.wallet!.id,
          customer_id: data.wallet!.customer_id,
          amount: data.refunded!.amount,
          balance: data.refunded!.balance_after,
          expires_at: data.refunded!.expires_at,
          reason: "cancellation",
          order_id: data.input.order_id,
          note: "Order cancelled",
        })),
      })
    })

    releaseLockStep({ key: lockKey })

    const result = transform({ input, refunded }, (data) => ({
      order_id: data.input.order_id,
      refunded: Boolean(data.refunded),
      amount: data.refunded?.amount ?? 0,
    }))

    return new WorkflowResponse(result)
  }
)
