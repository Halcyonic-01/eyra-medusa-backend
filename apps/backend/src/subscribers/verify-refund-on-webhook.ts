import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { REFUND_UPDATE_EVENT } from "../modules/payment-snapshot/webhook-guard"
import { verifyRefunds } from "../modules/payment-snapshot/refund-verification"

/** A provider says a refund changed (Razorpay refund.processed / refund.failed): check that refund now, not at the next sweep. */
export default async function verifyRefundOnWebhook({ event: { data }, container }: SubscriberArgs<{ refund_id: string }>) {
  try {
    await verifyRefunds(container, { now: new Date(), refundId: data.refund_id })
  } catch (error) {
    // The sweep checks it again within half an hour.
    container.resolve(ContainerRegistrationKeys.LOGGER).error(`[refund-verify] refund ${data.refund_id}: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = { event: REFUND_UPDATE_EVENT }
