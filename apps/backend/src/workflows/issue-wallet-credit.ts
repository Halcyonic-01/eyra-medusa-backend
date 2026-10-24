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
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { addMonths, creditExpiry } from "../modules/wallet/config"
import { roundMoney } from "../modules/wallet/utils"
import { assertCreditTargetStep } from "./steps/assert-credit-target"
import { createWalletTransactionStep } from "./steps/create-wallet-transaction"
import { getOrCreateWalletStep } from "./steps/get-or-create-wallet"
import { updateWalletBalanceStep } from "./steps/update-wallet-balance"

export type IssueWalletCreditInput = {
  customer_id: string
  amount: number
  reason: "return" | "exchange"
  /** The order being returned or exchanged. */
  order_id?: string
  note?: string
  /** Admin user or API key that issued the credit, for the audit trail. */
  created_by?: string
  /**
   * An idempotency key, for example "return:retreq_...". Issuing with a key that was
   * already used gives back the earlier credit and adds nothing, so a retried
   * return or exchange can never pay twice.
   */
  reference?: string
  /** How long this credit stays usable, in months; 0 means it never expires. Defaults to the wallet's setting. */
  validity_months?: number
}

/**
 * Adds store credit to a customer's wallet after staff approve a return or
 * an exchange. Creates the wallet on first use.
 */
export const issueWalletCreditWorkflow = createWorkflow(
  "issue-wallet-credit",
  function (input: IssueWalletCreditInput) {
    const lockKey = transform({ input }, (data) => `wallet:${data.input.customer_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const { data: customers } = useQueryGraphStep({
      entity: "customer",
      fields: ["id", "email"],
      filters: { id: input.customer_id },
    })

    const orders = when("has-order-id", input, (data) => Boolean(data.order_id)).then(() => {
      const { data: found } = useQueryGraphStep({
        entity: "order",
        fields: ["id", "customer_id", "email"],
        filters: { id: input.order_id },
      }).config({ name: "find-order" })
      return found
    })

    assertCreditTargetStep({
      customer_id: input.customer_id,
      order_id: input.order_id,
      customers,
      orders,
    })

    const wallet = getOrCreateWalletStep({ customer_id: input.customer_id })

    const transactionInput = transform({ input, wallet }, (data) => {
      const amount = roundMoney(data.input.amount)
      return {
        wallet_id: data.wallet.id,
        type: "issued" as const,
        reason: data.input.reason,
        amount,
        balance_after: roundMoney(data.wallet.balance + amount),
        remaining: amount,
        expires_at:
          data.input.validity_months === undefined
            ? creditExpiry(new Date())
            : data.input.validity_months === 0
            ? null
            : addMonths(new Date(), data.input.validity_months),
        order_id: data.input.order_id ?? null,
        reference: data.input.reference ?? null,
        note: data.input.note ?? null,
        created_by: data.input.created_by ?? null,
      }
    })
    const transaction = createWalletTransactionStep(transactionInput)

    // A repeat run finds the credit already there and must not touch the balance or tell the customer again.
    when("credit-is-new", transaction, (data) => !data.already_recorded).then(() => {
      const balanceInput = transform({ wallet, transaction }, (data) => ({
        wallet_id: data.wallet.id,
        balance: data.transaction.balance_after,
      }))
      updateWalletBalanceStep(balanceInput)

      // Lets other parts of the system react, for example emailing the customer.
      emitEventStep({
        eventName: "wallet.credit_added",
        data: transform({ input, wallet, transaction }, (data) => ({
          kind: "issued",
          wallet_id: data.wallet.id,
          customer_id: data.wallet.customer_id,
          amount: data.transaction.amount,
          balance: data.transaction.balance_after,
          expires_at: data.transaction.expires_at,
          reason: data.input.reason,
          order_id: data.input.order_id ?? null,
          note: data.input.note ?? null,
        })),
      })
    })

    releaseLockStep({ key: lockKey })

    const result = transform({ wallet, transaction }, (data) => ({
      wallet_id: data.wallet.id,
      customer_id: data.wallet.customer_id,
      currency_code: data.wallet.currency_code,
      balance: data.transaction.balance_after,
      transaction: data.transaction,
    }))

    return new WorkflowResponse(result)
  }
)
