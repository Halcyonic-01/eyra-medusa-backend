import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { WALLET_MODULE } from "../../../modules/wallet"
import { listSpendableLots, sumLots } from "../../../modules/wallet/lots"
import type WalletModuleService from "../../../modules/wallet/service"
import { toNumber } from "../../../modules/wallet/utils"
import type { GetWalletsQuery } from "./validation"

type WalletRow = {
  id: string
  customer_id: string
  currency_code: string
  balance: unknown
}

type TransactionRow = {
  id: string
  type: string
  reason: string | null
  amount: unknown
  balance_after: unknown
  remaining: unknown
  expires_at: string | null
  order_id: string | null
  note: string | null
  created_at: string
}

/**
 * GET /admin/wallets
 *
 * With `customer_id`: that customer's wallet and recent ledger. A customer
 * without a wallet gets an empty one back, so callers never special-case it.
 * Without it: a page of wallets, newest first.
 *
 * `balance` is the credit that can be spent right now (unexpired batches).
 * `next_expiry` is the batch that lapses first, so customers are not surprised.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const walletService: WalletModuleService = req.scope.resolve(WALLET_MODULE)
  const { customer_id, limit, offset } = req.validatedQuery as GetWalletsQuery

  if (!customer_id) {
    const { data, metadata } = await query.graph({
      entity: "wallet",
      fields: ["id", "customer_id", "currency_code", "balance", "created_at"],
      pagination: { take: limit, skip: offset, order: { created_at: "DESC" } },
    })

    const rows = data as WalletRow[]
    const balances = await Promise.all(
      rows.map(async (wallet) => sumLots(await listSpendableLots(walletService, wallet.id)))
    )

    return res.json({
      wallets: rows.map((wallet, index) => ({
        ...wallet,
        balance: balances[index],
      })),
      count: metadata?.count ?? data.length,
      limit,
      offset,
    })
  }

  const { data: wallets } = await query.graph({
    entity: "wallet",
    fields: ["id", "customer_id", "currency_code", "balance"],
    filters: { customer_id },
  })
  const wallet = (wallets as WalletRow[])[0]

  if (!wallet) {
    return res.json({
      wallet: {
        id: null,
        customer_id,
        currency_code: "inr",
        balance: 0,
        next_expiry: null,
        transactions: [],
      },
    })
  }

  const lots = await listSpendableLots(walletService, wallet.id)
  const expiring = lots.find((lot) => lot.expires_at !== null)

  const { data: transactions } = await query.graph({
    entity: "wallet_transaction",
    fields: [
      "id",
      "type",
      "reason",
      "amount",
      "balance_after",
      "remaining",
      "expires_at",
      "order_id",
      "note",
      "created_at",
    ],
    filters: { wallet_id: wallet.id },
    pagination: { take: limit, skip: offset, order: { created_at: "DESC" } },
  })

  return res.json({
    wallet: {
      id: wallet.id,
      customer_id: wallet.customer_id,
      currency_code: wallet.currency_code,
      balance: sumLots(lots),
      next_expiry: expiring
        ? { amount: expiring.remaining, expires_at: expiring.expires_at?.toISOString() ?? null }
        : null,
      transactions: (transactions as TransactionRow[]).map((row) => ({
        id: row.id,
        type: row.type,
        reason: row.reason,
        amount: toNumber(row.amount),
        balance_after: toNumber(row.balance_after),
        remaining: toNumber(row.remaining),
        expires_at: row.expires_at,
        order_id: row.order_id,
        note: row.note,
        created_at: row.created_at,
      })),
    },
  })
}
