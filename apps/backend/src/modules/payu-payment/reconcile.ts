import type { MedusaContainer } from "@medusajs/framework/types"
import { reconcileCurrentAttempts, type ReconcileOutcome } from "../payment-snapshot/current-attempts"
import { PAYU_PROVIDER_ID } from "./attempt"

/**
 * PayU's current attempts only, for callers that want just PayU; the job runs
 * reconcileCurrentAttempts for every provider.
 */
export async function reconcilePayuAttempts(container: MedusaContainer, now: Date = new Date()): Promise<Record<string, ReconcileOutcome>> {
  return reconcileCurrentAttempts(container, { now, providers: [PAYU_PROVIDER_ID] })
}
