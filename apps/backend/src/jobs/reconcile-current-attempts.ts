import type { MedusaContainer } from "@medusajs/framework/types"
import { reconcileCurrentAttempts } from "../modules/payment-snapshot/current-attempts"

/**
 * Every five minutes: carts whose current Razorpay or PayU attempt was paid
 * but never confirmed (no webhook, no return, no completion) are completed
 * from the provider's own records, or refunded if the cart refuses. Replaces
 * the PayU-only sweep; Razorpay had none.
 */
export default async function reconcileCurrentAttemptsJob(container: MedusaContainer) {
  await reconcileCurrentAttempts(container)
}

export const config = {
  name: "reconcile-current-attempts",
  schedule: "*/5 * * * *",
}
