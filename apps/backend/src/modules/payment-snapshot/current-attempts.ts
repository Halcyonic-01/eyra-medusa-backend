import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { GatewayUnavailableError, prepaidProviderIds } from "./gateways"
import { adoptMissedPayment, LATE_LOOKBACK_HOURS, loadCartOrder, settleLatePayments, type MissedPaymentOutcome } from "./late-payments"
import { attemptRef } from "./rules"
import type PaymentSnapshotModuleService from "./service"

/** A new attempt is left to the browser and the webhooks for this long (Medusa processes a webhook after 5 s, 3 tries). */
export const RECONCILE_GRACE_MINUTES = 3
/** Attempts asked about per run. */
const LIMIT = 25
/** Candidates read per run, newest first, before the backoff below picks the due ones. */
const SCAN = 300

/**
 * How often an attempt is asked again, by its age: a payment is most likely to
 * be missed right after it is made, and an attempt left unpaid for hours is
 * usually abandoned. Keeps a backlog of abandoned checkouts from delaying a
 * fresh payment, and the providers from being asked needlessly.
 */
export function recheckMinutes(ageMinutes: number): number {
  if (ageMinutes < 60) return 5
  if (ageMinutes < 6 * 60) return 30
  return 180
}

/** Pure: whether an attempt is due to be asked now. */
export function attemptDue(attempt: { created_at: Date | string; reconciled_at?: Date | string | null }, now: Date): boolean {
  if (!attempt.reconciled_at) return true
  const age = (now.getTime() - new Date(attempt.created_at).getTime()) / 60000
  return now.getTime() - new Date(attempt.reconciled_at).getTime() >= recheckMinutes(age) * 60000
}

export type ReconcileOutcome = MissedPaymentOutcome | "completed" | "refused" | "unavailable" | "skipped"

type Attempt = {
  id: string
  cart_id: string
  provider_id: string
  provider_ref: string | null
  razorpay_order_id: string | null
  created_at: Date | string
  reconciled_at: Date | string | null
}

/**
 * Missed confirmations, any provider: current attempts whose cart is not an
 * order, in case the customer paid and then neither came back nor was any
 * webhook received. Each is asked of its own provider; a payment taken in full
 * is completed into the order through the same recovered-payment path as a
 * late payment (refunded if the cart refuses it). Pending payments are left
 * alone, an unreachable provider is asked again next run, and nothing is ever
 * decided from an uncertain answer. Replaced attempts are the late-payment
 * sweep's job. Safe to run any number of times, alongside webhooks.
 */
export async function reconcileCurrentAttempts(
  container: MedusaContainer,
  options: { now?: Date; providers?: string[] } = {}
): Promise<Record<string, ReconcileOutcome>> {
  const now = options.now ?? new Date()
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const candidates = (await service.listPaymentPriceSnapshots(
    {
      provider_id: options.providers ?? prepaidProviderIds(),
      superseded_at: null,
      created_at: {
        $gte: new Date(now.getTime() - LATE_LOOKBACK_HOURS * 3600 * 1000),
        $lt: new Date(now.getTime() - RECONCILE_GRACE_MINUTES * 60 * 1000),
      },
    },
    // Newest first: that is where a payment is most likely to have been missed.
    { order: { created_at: "DESC" }, take: SCAN }
  )) as unknown as Attempt[]
  const attempts = candidates.filter((attempt) => attemptDue(attempt, now)).slice(0, LIMIT)

  const outcomes: Record<string, ReconcileOutcome> = {}
  // A provider that could not be asked is not asked again this run: an outage must not use up the run.
  const down = new Set<string>()
  for (const attempt of attempts) {
    const ref = attemptRef(attempt)
    if (down.has(attempt.provider_id)) {
      outcomes[ref] = "unavailable"
      continue
    }
    await service.updatePaymentPriceSnapshots({ id: attempt.id, reconciled_at: now })
    try {
      if (!ref || (await loadCartOrder(container, attempt.cart_id))) {
        outcomes[ref] = "skipped"
        continue
      }
      const adopted = await adoptMissedPayment(container, attempt.cart_id, attempt.id)
      if (adopted === "adopted") {
        const settled = await settleLatePayments(container, attempt.cart_id, { complete: true })
        outcomes[ref] = settled.order_id ? "completed" : settled.refunded || settled.refunding ? "refused" : "adopted"
        continue
      }
      if (adopted === "authorized") {
        // Held, not captured: Medusa's own completion authorizes and captures it.
        const { errors } = await completeCartWorkflow(container).run({ input: { id: attempt.cart_id }, throwOnError: false })
        if (errors?.length) {
          logger.error(`[reconcile] cart ${attempt.cart_id}: ${attempt.provider_id} ${ref} is authorized but the cart could not be completed: ${(errors[0].error as Error)?.message}`)
          outcomes[ref] = "refused"
          continue
        }
        outcomes[ref] = "completed"
        continue
      }
      outcomes[ref] = adopted
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        down.add(attempt.provider_id)
        logger.warn(`[reconcile] ${attempt.provider_id} could not be asked about ${ref}; will retry (skipping ${attempt.provider_id} for the rest of this run)`)
        outcomes[ref] = "unavailable"
        continue
      }
      logger.error(`[reconcile] could not reconcile ${attempt.provider_id} attempt ${ref}: ${(error as Error).message}`)
    }
  }
  return outcomes
}
