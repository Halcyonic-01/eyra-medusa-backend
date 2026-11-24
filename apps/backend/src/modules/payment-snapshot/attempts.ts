import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { sessionAttempt } from "./gateways"
import type { PaymentSnapshotRecord, SessionLike } from "./rules"
import type PaymentSnapshotModuleService from "./service"

export type AttemptLookup =
  | { found: false }
  | {
      found: true
      cart_id: string
      snapshot: PaymentSnapshotRecord & { id: string; payment_collection_id: string }
      /** The session that still pays this attempt, or why there is none (replaced). */
      session_id: string | null
      reason: "current" | "session_gone" | "session_mismatch"
    }

/**
 * Which recorded attempt (and cart) a provider's reference belongs to, from the
 * backend's own records, and whether a session still pays it. Used by provider
 * webhooks and returns, so nothing the browser sends picks the cart.
 */
export async function findAttempt(container: MedusaContainer, providerId: string, ref: string): Promise<AttemptLookup> {
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const [snapshot] = (await service.listPaymentPriceSnapshots({ provider_id: providerId, provider_ref: ref }, { take: 1 })) as unknown as (PaymentSnapshotRecord & {
    id: string
    payment_collection_id: string
  })[]
  if (!snapshot) return { found: false }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "payment_session",
    fields: ["id", "provider_id", "payment_collection_id", "data"],
    filters: { id: snapshot.payment_session_id },
  })
  const session = data[0] as unknown as (SessionLike & { payment_collection_id?: string }) | undefined
  const base = { found: true as const, cart_id: snapshot.cart_id, snapshot }
  if (!session) return { ...base, session_id: null, reason: "session_gone" }
  if (
    session.provider_id !== providerId ||
    session.payment_collection_id !== snapshot.payment_collection_id ||
    sessionAttempt(session).ref !== ref
  ) {
    return { ...base, session_id: null, reason: "session_mismatch" }
  }
  return { ...base, session_id: session.id, reason: "current" }
}
