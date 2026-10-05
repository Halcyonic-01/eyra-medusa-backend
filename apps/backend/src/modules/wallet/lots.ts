import type WalletModuleService from "./service"
import { roundMoney, toNumber } from "./utils"

/**
 * Credit batches. Every "issued" or "refunded" ledger row is a batch with an
 * unspent `remaining` amount and an expiry date. Spendable credit is the sum of
 * the unexpired batches, and spending always takes from the batch that expires
 * first, so credit that is about to lapse is used before credit that is not.
 */

export type CreditLot = {
  id: string
  remaining: number
  expires_at: Date | null
}

type LotRow = {
  id: string
  remaining: unknown
  expires_at?: Date | string | null
  created_at?: Date | string
}

function toLot(row: LotRow): CreditLot {
  return {
    id: row.id,
    remaining: toNumber(row.remaining),
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
  }
}

function expiresBefore(a: CreditLot, b: CreditLot): number {
  // Batches that never expire are spent last.
  const ax = a.expires_at ? a.expires_at.getTime() : Number.POSITIVE_INFINITY
  const bx = b.expires_at ? b.expires_at.getTime() : Number.POSITIVE_INFINITY
  return ax - bx
}

async function lotsWithCredit(service: WalletModuleService, walletId: string) {
  return service.listWalletTransactions({
    wallet_id: walletId,
    type: ["issued", "refunded"],
    remaining: { $gt: 0 },
  })
}

/** Unexpired batches with credit left, soonest-to-expire first. */
export async function listSpendableLots(
  service: WalletModuleService,
  walletId: string,
  now: Date = new Date()
): Promise<CreditLot[]> {
  const rows = (await lotsWithCredit(service, walletId)) as LotRow[]
  return rows
    .map(toLot)
    .filter((lot) => lot.expires_at === null || lot.expires_at.getTime() > now.getTime())
    .sort(expiresBefore)
}

/** Batches that reached their expiry date with credit still unspent. */
export async function listExpiredLots(
  service: WalletModuleService,
  walletId: string,
  now: Date = new Date()
): Promise<CreditLot[]> {
  const rows = (await lotsWithCredit(service, walletId)) as LotRow[]
  return rows
    .map(toLot)
    .filter((lot) => lot.expires_at !== null && lot.expires_at.getTime() <= now.getTime())
    .sort(expiresBefore)
}

export function sumLots(lots: CreditLot[]): number {
  return roundMoney(lots.reduce((sum, lot) => sum + lot.remaining, 0))
}

/** The credit a customer can spend right now. */
export async function spendableBalance(
  service: WalletModuleService,
  walletId: string,
  now: Date = new Date()
): Promise<number> {
  return sumLots(await listSpendableLots(service, walletId, now))
}

export type LotAllocation = {
  lot_id: string
  amount: number
  /** What the batch held before this spend, so the spend can be undone. */
  previous_remaining: number
}

/**
 * Splits `amount` across batches, soonest-to-expire first. Returns null when
 * the batches cannot cover it.
 */
export function allocateFromLots(lots: CreditLot[], amount: number): LotAllocation[] | null {
  let left = roundMoney(amount)
  const allocations: LotAllocation[] = []

  for (const lot of lots) {
    if (left <= 0) {
      break
    }
    const take = roundMoney(Math.min(lot.remaining, left))
    if (take > 0) {
      allocations.push({ lot_id: lot.id, amount: take, previous_remaining: lot.remaining })
      left = roundMoney(left - take)
    }
  }

  return left > 0 ? null : allocations
}
