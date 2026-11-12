import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { WALLET_MODULE } from "../wallet"
import { WALLET_CREDIT_LINE_REFERENCE, redemptionReference } from "../wallet/utils"
import { CHECKOUT_MARKER, ORPHAN_GRACE_MINUTES } from "./order-integrity"

const LOOKBACK_DAYS = 3
const LIMIT = 25
const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60 * 1000)

type Row = {
  id: string
  display_id: number
  email?: string | null
  status: string
  created_at: string | Date
  metadata?: Record<string, unknown> | null
  credit_lines?: ({ reference?: string | null; amount?: unknown } | null)[]
}

async function recent(container: MedusaContainer, now: Date, olderThanMinutes: number): Promise<Row[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "email", "status", "created_at", "metadata", "credit_lines.reference", "credit_lines.amount"],
    filters: {
      created_at: { $gte: minutesAgo(now, LOOKBACK_DAYS * 24 * 60), $lt: minutesAgo(now, olderThanMinutes) },
      status: { $nin: ["canceled", "draft"] },
    },
  })
  return data as unknown as Row[]
}

async function linkedToCart(container: MedusaContainer, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { order_id: ids } })
  return new Set((data as { order_id: string }[]).map((row) => row.order_id))
}

/** Orders a checkout started (they carry the marker) that are linked to no cart. */
export async function findOrphanOrders(container: MedusaContainer, now = new Date()): Promise<string[]> {
  const rows = (await recent(container, now, ORPHAN_GRACE_MINUTES)).filter((row) => typeof row.metadata?.[CHECKOUT_MARKER] === "string")
  const linked = await linkedToCart(container, rows.map((row) => row.id))
  return rows.filter((row) => !linked.has(row.id)).slice(0, LIMIT).map((row) => row.id)
}

/** Checkout orders young enough to still be waiting for the courier, for the reservation check. */
export async function findReservationCandidates(container: MedusaContainer, now = new Date()): Promise<string[]> {
  const rows = await recent(container, now, 5)
  const linked = await linkedToCart(container, rows.map((row) => row.id))
  return rows.filter((row) => linked.has(row.id)).slice(0, 100).map((row) => row.id)
}

/** Checkout orders that used wallet credit which was never deducted (the order-placed event was lost). */
export async function findUnredeemedWalletOrders(container: MedusaContainer, now = new Date()): Promise<string[]> {
  const rows = (await recent(container, now, 10)).filter((row) =>
    (row.credit_lines ?? []).some((line) => line?.reference === WALLET_CREDIT_LINE_REFERENCE && Number((line.amount as any)?.numeric ?? line.amount) > 0)
  )
  const linked = await linkedToCart(container, rows.map((row) => row.id))
  const wallet = container.resolve(WALLET_MODULE) as { listWalletTransactions: (f: Record<string, unknown>, c?: Record<string, unknown>) => Promise<{ reference?: string | null }[]> }
  const candidates = rows.filter((row) => linked.has(row.id))
  if (!candidates.length) return []
  const done = await wallet.listWalletTransactions(
    { reference: candidates.map((row) => redemptionReference(row.id)) },
    { take: candidates.length }
  )
  const redeemed = new Set(done.map((tx) => tx.reference))
  return candidates.filter((row) => !redeemed.has(redemptionReference(row.id))).slice(0, LIMIT).map((row) => row.id)
}

export type EmailCandidate = { order_id: string; display_id: number; attempts: number }

/** Checkout orders with no confirmation email yet, whose next retry is due. */
export async function findEmailCandidates(container: MedusaContainer, now = new Date()): Promise<EmailCandidate[]> {
  const rows = (await recent(container, now, 10)).filter((row) => {
    const m = row.metadata ?? {}
    if (!row.email || m.confirmation_email_sent || m.confirmation_email_gave_up) return false
    const next = typeof m.confirmation_email_next_at === "string" ? new Date(m.confirmation_email_next_at) : null
    return !next || next <= now
  })
  const linked = await linkedToCart(container, rows.map((row) => row.id))
  return rows
    .filter((row) => linked.has(row.id))
    .slice(0, LIMIT)
    .map((row) => ({ order_id: row.id, display_id: Number(row.display_id), attempts: Number(row.metadata?.confirmation_email_attempts ?? 0) }))
}
