import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SENT_KEY, sendOrderEvent, type OrderEventKind } from "../utils/analytics-orders"
import { posthogServerConfig } from "../utils/posthog"

/** How far back orders are checked. Older misses are left to Medusa's own reports. */
export const BACKLOG_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** Leave the order subscriber this long to send the event itself. */
export const BACKLOG_GRACE_MS = 10 * 60 * 1000

type Row = { id: string; created_at?: string | Date; canceled_at?: string | Date | null; metadata?: Record<string, unknown> | null }

/** Orders whose event is due and was never recorded as sent. Pure, for tests. */
export function dueOrders(rows: Row[], kind: OrderEventKind, now: number): string[] {
  return rows
    .filter((row) => {
      const at = kind === "order_placed" ? row.created_at : row.canceled_at
      if (!at) return false
      const time = new Date(at).getTime()
      return time >= now - BACKLOG_WINDOW_MS && time <= now - BACKLOG_GRACE_MS && !row.metadata?.[SENT_KEY[kind]]
    })
    .map((row) => row.id)
}

/**
 * Every fifteen minutes: send the order events that were never sent, because
 * PostHog was unreachable or Medusa's order event was lost. The orders table is
 * the outbox: an order without its "sent" marker is still owed.
 */
export default async function sendAnalyticsBacklog(container: MedusaContainer) {
  if (!posthogServerConfig()) return
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const now = Date.now()
  const since = new Date(now - BACKLOG_WINDOW_MS)
  const kinds: [OrderEventKind, "created_at" | "canceled_at"][] = [
    ["order_placed", "created_at"],
    ["order_cancelled", "canceled_at"],
  ]
  for (const [kind, field] of kinds) {
    try {
      const { data } = await query.graph({
        entity: "order",
        fields: ["id", "created_at", "canceled_at", "metadata"],
        filters: { [field]: { $gte: since } },
        pagination: { take: 500, order: { [field]: "ASC" } },
      })
      const due = dueOrders(data as Row[], kind, now)
      let sent = 0
      for (const id of due) if ((await sendOrderEvent(container, id, kind)) === "sent") sent++
      if (due.length) logger.info(`[analytics] backlog: ${sent} of ${due.length} ${kind} events sent`)
    } catch (error) {
      logger.warn(`[analytics] backlog for ${kind} not checked: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "send-analytics-backlog",
  schedule: "*/15 * * * *",
}
