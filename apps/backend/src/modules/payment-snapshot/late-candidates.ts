import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { LATE_LOOKBACK_HOURS } from "./late-payments"
import { sessionAttempt } from "./gateways"
import { attemptRef, type SessionLike } from "./rules"
import type PaymentSnapshotModuleService from "./service"

/** Attempts looked at per run, least recently checked first. */
const BATCH = 100
/** Carts settled per run, so a run stays well inside five minutes. */
const MAX_CARTS = 20
/** A new attempt is left to the webhook and the browser for this long. */
const GRACE_MINUTES = 2

/**
 * Carts the late-payment job should settle: those with a replaced attempt in
 * the lookback window (marked superseded, or whose session is gone or now pays
 * another Razorpay order), and those with a refund owed or a recovery that is
 * not an order yet.
 */
export async function findLatePaymentCarts(container: MedusaContainer, now: Date = new Date()): Promise<string[]> {
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const carts = new Set<string>()

  const open = (await service.listLateRazorpayPayments(
    { $or: [{ status: "refunding" }, { status: "recovered", order_id: null }] } as never,
    { take: MAX_CARTS }
  )) as unknown as { cart_id: string }[]
  for (const row of open) carts.add(row.cart_id)

  const attempts = (await service.listPaymentPriceSnapshots(
    {
      created_at: {
        $gte: new Date(now.getTime() - LATE_LOOKBACK_HOURS * 60 * 60 * 1000),
        $lt: new Date(now.getTime() - GRACE_MINUTES * 60 * 1000),
      },
    },
    // Never-checked attempts first (Postgres puts nulls last otherwise).
    { order: { late_checked_at: "ASC NULLS FIRST" }, take: BATCH }
  )) as unknown as {
    id: string
    cart_id: string
    payment_session_id: string
    provider_id: string
    provider_ref: string | null
    razorpay_order_id: string | null
    superseded_at: Date | null
  }[]
  if (!attempts.length) return [...carts].slice(0, MAX_CARTS)

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "payment_session",
    fields: ["id", "provider_id", "data"],
    filters: { id: [...new Set(attempts.map((a) => a.payment_session_id))] },
  })
  const sessions = new Map((data as unknown as SessionLike[]).map((s) => [s.id, s]))

  const current: string[] = []
  for (const attempt of attempts) {
    const session = sessions.get(attempt.payment_session_id)
    const replaced =
      Boolean(attempt.superseded_at) ||
      !session ||
      session.provider_id !== attempt.provider_id ||
      sessionAttempt(session).ref !== attemptRef(attempt)
    if (replaced) carts.add(attempt.cart_id)
    else current.push(attempt.id)
  }
  // Still the cart's own attempt: nothing late about it; look at the others first next time.
  if (current.length) {
    await service.updatePaymentPriceSnapshots({ selector: { id: current }, data: { late_checked_at: now } })
  }
  return [...carts].slice(0, MAX_CARTS)
}
