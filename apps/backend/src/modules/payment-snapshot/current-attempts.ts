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
/** Attempts asked about per run, least recently asked first. */
const LIMIT = 25

export type ReconcileOutcome = MissedPaymentOutcome | "completed" | "refused" | "unavailable" | "skipped"

type Attempt = { id: string; cart_id: string; provider_id: string; provider_ref: string | null; razorpay_order_id: string | null }

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
  const attempts = (await service.listPaymentPriceSnapshots(
    {
      provider_id: options.providers ?? prepaidProviderIds(),
      superseded_at: null,
      created_at: {
        $gte: new Date(now.getTime() - LATE_LOOKBACK_HOURS * 3600 * 1000),
        $lt: new Date(now.getTime() - RECONCILE_GRACE_MINUTES * 60 * 1000),
      },
    },
    // Never-asked attempts first (Postgres puts nulls last otherwise).
    { order: { reconciled_at: "ASC NULLS FIRST" }, take: LIMIT }
  )) as unknown as Attempt[]

  const outcomes: Record<string, ReconcileOutcome> = {}
  for (const attempt of attempts) {
    const ref = attemptRef(attempt)
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
        logger.warn(`[reconcile] ${attempt.provider_id} could not be asked about ${ref}; will retry`)
        outcomes[ref] = "unavailable"
        continue
      }
      logger.error(`[reconcile] could not reconcile ${attempt.provider_id} attempt ${ref}: ${(error as Error).message}`)
    }
  }
  return outcomes
}
