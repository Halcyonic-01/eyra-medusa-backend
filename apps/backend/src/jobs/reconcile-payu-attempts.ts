import type { MedusaContainer } from "@medusajs/framework/types"
import { payuConfig } from "../modules/payu-payment/config"
import { reconcilePayuAttempts } from "../modules/payu-payment/reconcile"

/** Every five minutes, when PayU is set up: complete carts PayU reports as paid that no return or webhook completed. */
export default async function reconcilePayuAttemptsJob(container: MedusaContainer) {
  if (!payuConfig()) return
  await reconcilePayuAttempts(container)
}

export const config = {
  name: "reconcile-payu-attempts",
  schedule: "*/5 * * * *",
}
