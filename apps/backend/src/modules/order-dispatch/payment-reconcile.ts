import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/** How far back to look. */
const LOOKBACK_DAYS = 3
/** Leave a completion that is still running alone for this long. */
const GRACE_MINUTES = 5
const LIMIT = 20

type OrderRow = {
  id: string
  display_id: number
  status: string
  metadata?: Record<string, unknown> | null
  payment_collections?: ({ status?: string; amount?: unknown; payments?: ({ id: string; canceled_at?: unknown } | null)[] } | null)[]
}

async function recentOrders(container: MedusaContainer, now: Date): Promise<OrderRow[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "metadata",
      "payment_collections.status",
      "payment_collections.amount",
      "payment_collections.payments.id",
      "payment_collections.payments.canceled_at",
    ],
    filters: {
      created_at: {
        $gte: new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
        $lt: new Date(now.getTime() - GRACE_MINUTES * 60 * 1000),
      },
      status: { $nin: ["canceled", "draft"] },
    },
  })
  return data as unknown as OrderRow[]
}

async function cartLinked(container: MedusaContainer, orderIds: string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set()
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { order_id: orderIds } })
  return new Set((data as { order_id: string }[]).map((row) => row.order_id))
}

export type ReconcileCandidates = {
  /** Linked to a checkout with money due, but no payment recorded. */
  paymentless: { order_id: string; display_id: number; alerted: boolean }[]
  /** Not linked to any checkout and not a linked replacement: left over from an interrupted completion. */
  orphans: { order_id: string; display_id: number }[]
}

export async function findReconcileCandidates(container: MedusaContainer, now: Date = new Date()): Promise<ReconcileCandidates> {
  const orders = await recentOrders(container, now)
  const linked = await cartLinked(container, orders.map((order) => order.id))

  const paymentless = orders
    .filter((order) => linked.has(order.id))
    .filter((order) => {
      const open = (order.payment_collections ?? []).filter((c) => c && c.status !== "canceled" && Number((c.amount as any)?.numeric ?? c.amount) > 0)
      return open.length > 0 && !open.some((c) => (c!.payments ?? []).some((p) => p && !p.canceled_at))
    })
    .slice(0, LIMIT)
    .map((order) => ({ order_id: order.id, display_id: Number(order.display_id), alerted: Boolean(order.metadata?.payment_unconfirmed_alerted) }))

  const orphans = orders
    .filter((order) => !linked.has(order.id) && !order.metadata?.replacement_for_order && !order.metadata?.orphan_alerted)
    .slice(0, LIMIT)
    .map((order) => ({ order_id: order.id, display_id: Number(order.display_id) }))

  return { paymentless, orphans }
}
