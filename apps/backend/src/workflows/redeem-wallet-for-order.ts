import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { consumeWalletLotsStep } from "./steps/consume-wallet-lots"
import { createWalletTransactionStep } from "./steps/create-wallet-transaction"
import { buildWalletRedemptionStep } from "./steps/build-wallet-redemption"
import { extractWalletCreditLinesStep } from "./steps/extract-wallet-credit-lines"
import { getWalletStep } from "./steps/get-wallet"
import { updateWalletBalanceStep } from "./steps/update-wallet-balance"

export type RedeemWalletForOrderInput = {
  order_id: string
}

/**
 * Deducts the wallet credit an order used. Runs when the order is placed, so
 * the balance only ever drops for orders that really exist. Idempotent: an
 * order that was already redeemed is left alone.
 */
export const redeemWalletForOrderWorkflow = createWorkflow(
  "redeem-wallet-for-order",
  function (input: RedeemWalletForOrderInput) {
    const { data: orders } = useQueryGraphStep({
      entity: "order",
      fields: ["id", "credit_lines.*"],
      filters: { id: input.order_id },
    })

    const walletLines = extractWalletCreditLinesStep({
      records: orders,
      allow_completed: true,
    })

    // Each step below copes with "this order used no wallet credit", so the
    // flow stays flat: Medusa does not support one when() inside another.
    const lookup = getWalletStep({ id: walletLines.wallet_id })

    const lockKey = transform({ lookup }, (data) => `wallet:${data.lookup?.customer_id ?? "none"}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    // Read again now that the lock is held, so the balance is current.
    const wallet = getWalletStep({ id: walletLines.wallet_id }).config({
      name: "get-wallet-locked",
    })

    const redemption = buildWalletRedemptionStep({
      order_id: input.order_id,
      amount: walletLines.amount,
      wallet,
    })

    when("should-redeem", redemption, (data) => !data.skip).then(() => {
      consumeWalletLotsStep(
        transform({ redemption }, (data) => ({ allocations: data.redemption.allocations }))
      )
      createWalletTransactionStep(
        transform({ redemption }, (data) => data.redemption.transaction!)
      )
      updateWalletBalanceStep(
        transform({ redemption, wallet }, (data) => ({
          wallet_id: data.wallet!.id,
          balance: data.redemption.new_balance,
        }))
      )
    })

    releaseLockStep({ key: lockKey })

    const result = transform({ input, redemption, walletLines }, (data) => ({
      order_id: data.input.order_id,
      redeemed: !data.redemption.skip,
      amount: data.walletLines.amount,
    }))

    return new WorkflowResponse(result)
  }
)
