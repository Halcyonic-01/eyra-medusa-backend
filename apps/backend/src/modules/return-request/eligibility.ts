import { RETURN_WINDOW_DAYS } from "../../utils/tax-config"

/**
 * When a delivered order can still be returned or exchanged: within 7 days of
 * the day it was delivered. Pure, so the rule can be checked on its own.
 */

export type DeliveryState =
  | { kind: "delivered"; at: Date }
  /** The courier has it and it has not been delivered. */
  | { kind: "in_transit" }
  /** A failed or refused delivery on its way back to us. */
  | { kind: "returning" }
  /** Nothing is known about delivery, for example an order that never went through the courier's tracking. */
  | { kind: "unknown" }

type DispatchFacts = {
  delivered_at?: Date | string | null
  shiprocket_status?: string | null
  rto_initiated_at?: Date | string | null
} | null

const valid = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * What is known about an order's delivery. The dispatch record is the source of
 * truth; the order's own tracking keys are read when the record has nothing,
 * because the storefront's tracking route writes those.
 */
export function deliveryStateOf(dispatch: DispatchFacts, metadata: Record<string, unknown> | null | undefined): DeliveryState {
  if (valid(dispatch?.rto_initiated_at)) return { kind: "returning" }

  const delivered = valid(dispatch?.delivered_at)
  if (delivered) return { kind: "delivered", at: delivered }

  const status = String(dispatch?.shiprocket_status ?? metadata?.shiprocket_status ?? "").trim().toUpperCase()
  if (status === "DELIVERED") {
    const stamp = valid(metadata?.shiprocket_status_updated_at as string | undefined)
    return stamp ? { kind: "delivered", at: stamp } : { kind: "unknown" }
  }
  if (status.startsWith("RTO")) return { kind: "returning" }
  if (status) return { kind: "in_transit" }
  return { kind: "unknown" }
}

const DAY_MS = 24 * 60 * 60 * 1000

export function returnWindowEnds(deliveredAt: Date, days: number = RETURN_WINDOW_DAYS): Date {
  return new Date(deliveredAt.getTime() + days * DAY_MS)
}

export function withinReturnWindow(deliveredAt: Date, now: Date = new Date(), days: number = RETURN_WINDOW_DAYS): boolean {
  return now.getTime() <= returnWindowEnds(deliveredAt, days).getTime()
}
