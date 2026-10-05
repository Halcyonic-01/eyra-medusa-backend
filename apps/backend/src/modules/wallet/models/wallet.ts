import { model } from "@medusajs/framework/utils"
import { WalletTransaction } from "./wallet-transaction"

/**
 * One wallet per customer. The balance is the spendable store credit in the
 * wallet's currency, in major units (rupees), like every other Medusa amount.
 */
export const Wallet = model.define("wallet", {
  id: model.id({ prefix: "wallet" }).primaryKey(),
  customer_id: model.text().unique(),
  currency_code: model.text().default("inr"),
  balance: model.bigNumber().default(0),
  transactions: model.hasMany(() => WalletTransaction, {
    mappedBy: "wallet",
  }),
})
