import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { sessionAttempt } from "./gateways"
import type PaymentSnapshotModuleService from "./service"

/**
 * Duplicate protection for payment webhooks. Gateways deliver at least once:
 * Razorpay retries until it gets a 2xx and can send the same event twice,
 * PayU may post the same transaction more than once. Each notice is keyed by
 * what it is about, and handed on only when it is new, or when an earlier
 * delivery was handed on long enough ago that it evidently did not finish (its
 * cart is still not an order). Everything downstream is idempotent anyway;
 * this keeps duplicates from reaching Medusa's payment workflow at all.
 */

/** Medusa handles a webhook about 5 s after it arrives and tries 3 times; well beyond that, a redelivery is a retry. */
export const REPLAY_WINDOW_MINUTES = 10
const LOCK_SECONDS = 30

export type WebhookEventInput = {
  provider_id: string
  event_key: string
  event_type: string
  provider_event_id?: string | null
  attempt_ref: string | null
  cart_id: string | null
  outcome: "forwarded" | "settling"
  /** The notice says money was captured, so it is done only once Medusa recorded the capture too. */
  needs_capture: boolean
}

export type WebhookAdmission =
  | { action: "handle"; first: boolean }
  | { action: "duplicate"; reason: "in_flight" | "already_recorded" }

type EventRow = { id: string; forwarded_at: Date | string; deliveries: number; duplicates: number }

/** Razorpay: the event and the payment it is about (the same payment is captured once, authorized once). */
export function razorpayEventKey(event: string, paymentId: string | null, orderId: string): string {
  return `${event}:${paymentId ?? orderId}`
}

/**
 * PayU: the transaction's state and our transaction id (a pending notice and a
 * success are different events). Only fields PayU's hash covers: mihpayid is
 * not signed, so a replay with it changed must still count as the same notice.
 */
export function payuEventKey(fields: { status?: string; txnid?: string }): string {
  return `${(fields.status ?? "").toLowerCase()}:${fields.txnid ?? ""}`
}

/**
 * Whether what the notice would do is already done: the cart's order has a
 * recorded payment for this attempt, captured when the notice is a capture.
 * An order alone is not enough: the storefront can place it before Medusa has
 * recorded the payment (a crash) or its capture (which only this notice brings).
 */
export async function attemptSettled(container: MedusaContainer, cartId: string, attemptRef: string, needsCapture: boolean): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: links } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
  const orderId = (links[0] as { order_id?: string } | undefined)?.order_id
  if (!orderId) return false
  const { data } = await query.graph({
    entity: "order",
    fields: ["payment_collections.payments.provider_id", "payment_collections.payments.data", "payment_collections.payments.captured_at"],
    filters: { id: orderId },
  })
  const payments = ((data[0] as any)?.payment_collections ?? []).flatMap((c: any) => c?.payments ?? []).filter(Boolean)
  return payments.some((p: any) => sessionAttempt(p).ref === attemptRef && (!needsCapture || Boolean(p.captured_at)))
}

/** Pure: what to do with a delivery of a notice seen before. */
export function judgeRedelivery(row: { forwarded_at: Date | string }, alreadyRecorded: boolean, now: Date): WebhookAdmission {
  if (alreadyRecorded) return { action: "duplicate", reason: "already_recorded" }
  if (now.getTime() - new Date(row.forwarded_at).getTime() < REPLAY_WINDOW_MINUTES * 60 * 1000) {
    return { action: "duplicate", reason: "in_flight" }
  }
  return { action: "handle", first: false }
}

/**
 * Records a delivery and says whether to act on it. Throws when it cannot
 * decide (database or lock trouble); the caller then answers with an error so
 * the gateway delivers again, and nothing is dropped.
 */
export async function admitWebhookEvent(container: MedusaContainer, input: WebhookEventInput, now: Date = new Date()): Promise<WebhookAdmission> {
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const key = `payment-webhook:${input.provider_id}:${input.event_key}`
  return container.resolve(Modules.LOCKING).execute(
    key,
    async () => {
      const [row] = (await service.listPaymentWebhookEvents(
        { provider_id: input.provider_id, event_key: input.event_key },
        { take: 1 }
      )) as unknown as EventRow[]
      const recorded = Boolean(input.cart_id && input.attempt_ref && (await attemptSettled(container, input.cart_id, input.attempt_ref, input.needs_capture)))
      if (!row) {
        try {
          const { needs_capture: _needsCapture, ...record } = input
          await service.createPaymentWebhookEvents({
            ...record,
            provider_event_id: input.provider_event_id ?? null,
            forwarded_at: now,
            last_seen_at: now,
            duplicates: recorded ? 1 : 0,
          })
          // Already the order's payment (a sweep or the customer's return got there first): nothing left to do.
          return recorded ? ({ action: "duplicate", reason: "already_recorded" } as const) : ({ action: "handle", first: true } as const)
        } catch (error) {
          // Another instance recorded it first (unique index): that delivery is the one being handled.
          const [winner] = await service.listPaymentWebhookEvents({ provider_id: input.provider_id, event_key: input.event_key }, { take: 1 })
          if (winner) return { action: "duplicate", reason: "in_flight" } as const
          throw error
        }
      }

      const verdict = judgeRedelivery(row, recorded, now)
      await service.updatePaymentWebhookEvents({
        id: row.id,
        deliveries: row.deliveries + 1,
        last_seen_at: now,
        ...(verdict.action === "handle" ? { forwarded_at: now, outcome: input.outcome } : { duplicates: row.duplicates + 1 }),
      })
      return verdict
    },
    { timeout: LOCK_SECONDS }
  )
}
