import { model } from "@medusajs/framework/utils"
import { Wallet } from "./wallet"

/**
 * Append-only ledger. Rows are never edited except for `remaining` on a
 * credit row as it is spent, and every change to a wallet's spendable balance
 * is one row, with `balance_after` recording the balance right after it.
 *
 * - issued:   credit added by staff for an approved return or exchange
 * - refunded: credit given back because an order that used it was cancelled
 * - redeemed: credit spent on an order at checkout
 * - expired:  credit that reached its expiry date unspent
 *
 * "issued" and "refunded" rows are credit batches: `remaining` is how much of
 * the batch is still unspent and `expires_at` is when it stops being usable.
 * Spending takes from the batch that expires first.
 *
 * `reference` is an idempotency key (for example "redeem:order_123") so a
 * retried workflow can never apply the same movement twice.
 */
export const WalletTransaction = model
  .define("wallet_transaction", {
    id: model.id({ prefix: "wtxn" }).primaryKey(),
    type: model.enum(["issued", "redeemed", "refunded", "expired"]),
    reason: model.enum(["return", "exchange", "cancellation"]).nullable(),
    amount: model.bigNumber(),
    balance_after: model.bigNumber(),
    /** Credit rows only: the unspent part of this batch. */
    remaining: model.bigNumber().default(0),
    /** Credit rows only: when the batch stops being usable. Null means never. */
    expires_at: model.dateTime().nullable(),
    order_id: model.text().nullable(),
    reference: model.text().nullable(),
    note: model.text().nullable(),
    created_by: model.text().nullable(),
    /** For example which batches a redemption took from. */
    metadata: model.json().nullable(),
    wallet: model.belongsTo(() => Wallet, {
      mappedBy: "transactions",
    }),
  })
  .indexes([
    {
      on: ["reference"],
      unique: true,
      where: "reference IS NOT NULL AND deleted_at IS NULL",
    },
    {
      on: ["order_id"],
    },
    {
      on: ["wallet_id", "expires_at"],
      where: "remaining > 0 AND deleted_at IS NULL",
    },
  ])
