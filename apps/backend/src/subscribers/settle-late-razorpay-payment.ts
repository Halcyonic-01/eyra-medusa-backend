import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { LATE_PAYMENT_EVENT, settleLatePayments } from "../modules/payment-snapshot/late-payments"

/**
 * A replaced Razorpay attempt was paid (seen by the webhook guard or when a new
 * payment was refused): recover it into the order or refund it. A failure is
 * left to the late-payment job, which settles the cart again.
 */
export default async function settleLateRazorpayPaymentHandler({ event: { data }, container }: SubscriberArgs<{ cart_id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const result = await settleLatePayments(container, data.cart_id, { complete: true })
    logger.info(`[late-payment] settled cart ${data.cart_id}: ${JSON.stringify(result)}`)
  } catch (error) {
    logger.error(`[late-payment] could not settle cart ${data.cart_id} now, the job will retry: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: LATE_PAYMENT_EVENT,
}
