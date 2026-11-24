import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { PAYMENT_SNAPSHOT_MODULE } from "../payment-snapshot"
import { findAttempt } from "../payment-snapshot/attempts"
import { paidTowardsAttempt } from "../payment-snapshot/gateways"
import { loadCartOrder } from "../payment-snapshot/late-payments"
import { attemptAmountPaise } from "../payment-snapshot/rules"
import type PaymentSnapshotModuleService from "../payment-snapshot/service"
import { payuGateway } from "../payment-snapshot/gateways/payu"
import { PAYU_PROVIDER_ID } from "./attempt"

/** How far back, and how long to leave a new attempt to the return and the webhook. Least recently checked first. */
const LOOKBACK_HOURS = 48
const GRACE_MINUTES = 2
const LIMIT = 20

export type PayuReconcileOutcome = "completed" | "not_paid" | "pending" | "refused" | "skipped"

/**
 * PayU's current attempts whose cart is not an order yet, in case the customer
 * never came back and no webhook arrived. A transaction PayU reports as paid in
 * full is completed like any other; a pending one is left alone (and blocks
 * paying another way, see the checkout guard). Replaced attempts are the
 * late-payment settle's job, not this one.
 */
export async function reconcilePayuAttempts(container: MedusaContainer, now: Date = new Date()): Promise<Record<string, PayuReconcileOutcome>> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const attempts = (await service.listPaymentPriceSnapshots(
    {
      provider_id: PAYU_PROVIDER_ID,
      superseded_at: null,
      created_at: { $gte: new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000), $lt: new Date(now.getTime() - GRACE_MINUTES * 60 * 1000) },
    },
    { order: { late_checked_at: "ASC NULLS FIRST" }, take: LIMIT }
  )) as unknown as { id: string; cart_id: string; provider_ref: string | null; provider_amount_paise: number | null; razorpay_amount_paise: number | null }[]

  const outcomes: Record<string, PayuReconcileOutcome> = {}
  for (const attempt of attempts) {
    const ref = attempt.provider_ref ?? ""
    await service.updatePaymentPriceSnapshots({ id: attempt.id, late_checked_at: now })
    try {
      if (!ref || (await loadCartOrder(container, attempt.cart_id))) {
        outcomes[ref] = "skipped"
        continue
      }
      const lookup = await findAttempt(container, PAYU_PROVIDER_ID, ref)
      if (!lookup.found || !lookup.session_id) {
        outcomes[ref] = "skipped"
        continue
      }
      const paid = await payuGateway.fetchAttempt(ref)
      if (paid?.payments.some((p) => p.status === "pending")) {
        outcomes[ref] = "pending"
        continue
      }
      if (!paid || paidTowardsAttempt(paid) !== attemptAmountPaise(attempt)) {
        outcomes[ref] = "not_paid"
        continue
      }
      const { errors } = await completeCartWorkflow(container).run({ input: { id: attempt.cart_id }, throwOnError: false })
      if (errors?.length) {
        // Paid but the cart refuses (stock, prices): a person decides; nothing is refunded automatically here.
        logger.error(`[payu-reconcile] cart ${attempt.cart_id} is paid at PayU (${ref}) but could not be completed: ${(errors[0].error as Error)?.message}`)
        outcomes[ref] = "refused"
        continue
      }
      logger.warn(`[payu-reconcile] completed cart ${attempt.cart_id} from PayU transaction ${ref} (no return or webhook seen)`)
      outcomes[ref] = "completed"
    } catch (error) {
      logger.error(`[payu-reconcile] could not check PayU transaction ${ref}: ${(error as Error).message}`)
    }
  }
  return outcomes
}
