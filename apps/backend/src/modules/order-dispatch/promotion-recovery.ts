import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { Pg } from "./transitions"

/**
 * Gives back a discount-code use that a leftover order (see order-integrity)
 * consumed. Medusa counts a code's use in the same parallel step that a crash
 * can interrupt, so a leftover may or may not have been counted. A once-per-
 * customer code that was counted would make the customer's own retry fail with
 * "Promotion usage exceeds the budget limit".
 *
 * A use is only given back when the counters prove it was taken: Medusa's
 * counter is higher than the uses of every real order of that code. If that
 * cannot be shown, nothing is given back, so an extra use is never handed out.
 * The counter is read before the orders, so a completion running at the same
 * time can only make this decline, never revert wrongly.
 */

export type UsageEvidence =
  | { kind: "count"; registered: number; expected: number }
  | { kind: "spend"; registered: number; expected: number; orphan_amount: number }
  | { kind: "none" }

const EPSILON = 0.005

/** Whether the counters prove the leftover's use was counted. */
export function orphanUseWasCounted(evidence: UsageEvidence): boolean {
  if (evidence.kind === "none") return false
  if (evidence.kind === "spend") {
    return evidence.orphan_amount > EPSILON && evidence.registered - evidence.expected >= evidence.orphan_amount - EPSILON
  }
  return evidence.registered - evidence.expected >= 1
}

const num = (value: unknown) => Number((value as { numeric?: unknown })?.numeric ?? value ?? 0)

type CodeUse = { code: string; amount: number }

/** The codes a leftover order carries, with the discount each gave. */
async function orphanCodes(pg: Pg, orderId: string): Promise<CodeUse[]> {
  const { rows } = await pg.raw(
    `SELECT code, SUM(amount)::float AS amount FROM (
       SELECT DISTINCT a.id, a.code, a.amount
         FROM order_item oi
         JOIN order_line_item_adjustment a ON a.item_id = oi.item_id AND a.deleted_at IS NULL
        WHERE oi.order_id = ? AND oi.deleted_at IS NULL AND a.code IS NOT NULL
       UNION
       SELECT DISTINCT sa.id, sa.code, sa.amount
         FROM order_shipping os
         JOIN order_shipping_method_adjustment sa ON sa.shipping_method_id = os.shipping_method_id AND sa.deleted_at IS NULL
        WHERE os.order_id = ? AND os.deleted_at IS NULL AND sa.code IS NOT NULL
     ) uses GROUP BY code`,
    [orderId, orderId]
  )
  return rows.map((row) => ({ code: String(row.code), amount: Number(row.amount) }))
}

/**
 * Uses of a code by real orders: every order except this leftover and leftovers
 * already voided. Orders not yet known to be leftovers count as real, which can
 * only make a revert less likely.
 */
async function realUses(
  pg: Pg,
  orphanId: string,
  code: string,
  filter: { column: "customer_id" | "email"; value: string } | null
): Promise<{ orders: number; amount: number }> {
  const scope = filter ? `AND o.${filter.column} = ?` : ""
  const params = filter ? [orphanId, filter.value] : [orphanId]
  const { rows } = await pg.raw(
    `WITH real_orders AS (
       SELECT o.id FROM "order" o
        WHERE o.deleted_at IS NULL AND o.id <> ? ${scope}
          AND (o.metadata->>'orphan_voided_at') IS NULL
     ),
     uses AS (
       SELECT DISTINCT oi.order_id, a.id, a.amount
         FROM order_item oi
         JOIN order_line_item_adjustment a ON a.item_id = oi.item_id AND a.deleted_at IS NULL
        WHERE oi.deleted_at IS NULL AND a.code = ? AND oi.order_id IN (SELECT id FROM real_orders)
       UNION
       SELECT DISTINCT os.order_id, sa.id, sa.amount
         FROM order_shipping os
         JOIN order_shipping_method_adjustment sa ON sa.shipping_method_id = os.shipping_method_id AND sa.deleted_at IS NULL
        WHERE os.deleted_at IS NULL AND sa.code = ? AND os.order_id IN (SELECT id FROM real_orders)
     )
     SELECT COUNT(DISTINCT order_id)::int AS orders, COALESCE(SUM(amount), 0)::float AS amount FROM uses`,
    [...params, code, code]
  )
  return { orders: Number(rows[0]?.orders ?? 0), amount: Number(rows[0]?.amount ?? 0) }
}

type PromotionRow = {
  code: string
  limit?: number | null
  used?: number | null
  campaign?: { budget?: { id: string; type: string; limit?: unknown; used?: unknown; attribute?: string | null } | null } | null
}

async function evidenceFor(pg: Pg, orphan: { id: string; customer_id: string | null; email: string | null }, use: CodeUse, promotion: PromotionRow): Promise<UsageEvidence> {
  const budget = promotion.campaign?.budget
  if (budget?.type === "use_by_attribute") {
    const column = budget.attribute === "customer_email" ? "email" : budget.attribute === "customer_id" ? "customer_id" : null
    const value = column === "email" ? orphan.email : column === "customer_id" ? orphan.customer_id : null
    if (!column || !value) return { kind: "none" }
    const counter = await pg.raw(
      `SELECT COALESCE(SUM(used), 0)::float AS used FROM promotion_campaign_budget_usage WHERE budget_id = ? AND attribute_value = ? AND deleted_at IS NULL`,
      [budget.id, value]
    )
    const registered = Number(counter.rows[0]?.used ?? 0)
    const expected = (await realUses(pg, orphan.id, use.code, { column, value })).orders
    return { kind: "count", registered, expected }
  }
  if (budget?.type === "usage") {
    const counter = await pg.raw(`SELECT used FROM promotion_campaign_budget WHERE id = ?`, [budget.id])
    const registered = num(counter.rows[0]?.used)
    return { kind: "count", registered, expected: (await realUses(pg, orphan.id, use.code, null)).orders }
  }
  if (budget?.type === "spend") {
    const counter = await pg.raw(`SELECT used FROM promotion_campaign_budget WHERE id = ?`, [budget.id])
    const registered = num(counter.rows[0]?.used)
    return { kind: "spend", registered, expected: (await realUses(pg, orphan.id, use.code, null)).amount, orphan_amount: use.amount }
  }
  if (typeof promotion.limit === "number") {
    const counter = await pg.raw(`SELECT used FROM promotion WHERE code = ? AND deleted_at IS NULL`, [use.code])
    const registered = num(counter.rows[0]?.used)
    return { kind: "count", registered, expected: (await realUses(pg, orphan.id, use.code, null)).orders }
  }
  return { kind: "none" }
}

/** Gives back each code use the leftover is proven to have taken. Returns the codes given back. */
export async function revertCountedOrphanUses(container: MedusaContainer, orphanId: string): Promise<string[]> {
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  const uses = await orphanCodes(pg, orphanId)
  if (!uses.length) return []

  const { rows } = await pg.raw(`SELECT id, customer_id, email FROM "order" WHERE id = ?`, [orphanId])
  const orphan = rows[0] as { id: string; customer_id: string | null; email: string | null } | undefined
  if (!orphan) return []

  const promotions = container.resolve(Modules.PROMOTION)
  const found = (await promotions.listPromotions(
    { code: uses.map((u) => u.code) },
    { relations: ["campaign", "campaign.budget"] }
  )) as unknown as PromotionRow[]

  const reverted: string[] = []
  for (const use of uses) {
    const promotion = found.find((p) => p.code === use.code)
    if (!promotion) continue
    const evidence = await evidenceFor(pg, orphan, use, promotion)
    if (!orphanUseWasCounted(evidence)) continue
    await promotions.revertUsage(
      [{ action: "addItemAdjustment", code: use.code, amount: use.amount }] as never,
      { customer_id: orphan.customer_id, customer_email: orphan.email } as never
    )
    reverted.push(use.code)
  }
  return reverted
}
