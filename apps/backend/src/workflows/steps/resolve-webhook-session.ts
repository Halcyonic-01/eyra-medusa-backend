import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PAYMENT_SNAPSHOT_MODULE } from "../../modules/payment-snapshot"
import { RAZORPAY_PROVIDER_ID, sessionRazorpayOrderId, type SessionLike } from "../../modules/payment-snapshot/rules"
import type PaymentSnapshotModuleService from "../../modules/payment-snapshot/service"

export type WebhookSession =
  | { session_id: string; cart_id: string }
  | { session_id: null; reason: "no_snapshot" | "session_gone" | "session_mismatch" }

/**
 * Finds the Medusa payment session a Razorpay order belongs to, from the
 * backend's own snapshot. The session must still exist, be a Razorpay session
 * on the snapshot's payment collection, and point at the same Razorpay order.
 */
export const resolveWebhookSessionStep = createStep(
  "resolve-webhook-session",
  async (input: { razorpay_order_id: string }, { container }) => {
    const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
    const [snapshot] = await service.listPaymentPriceSnapshots({ razorpay_order_id: input.razorpay_order_id }, { take: 1 })
    if (!snapshot) return new StepResponse<WebhookSession>({ session_id: null, reason: "no_snapshot" })

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "payment_session",
      fields: ["id", "provider_id", "payment_collection_id", "data"],
      filters: { id: snapshot.payment_session_id },
    })
    const session = data[0] as unknown as (SessionLike & { payment_collection_id?: string }) | undefined
    if (!session) return new StepResponse<WebhookSession>({ session_id: null, reason: "session_gone" })
    if (
      session.provider_id !== RAZORPAY_PROVIDER_ID ||
      session.payment_collection_id !== snapshot.payment_collection_id ||
      sessionRazorpayOrderId(session) !== input.razorpay_order_id
    ) {
      return new StepResponse<WebhookSession>({ session_id: null, reason: "session_mismatch" })
    }
    return new StepResponse<WebhookSession>({ session_id: session.id, cart_id: snapshot.cart_id })
  }
)
