import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ORDER_DISPATCH_MODULE } from "../modules/order-dispatch"
import { loadCancellationContext } from "../modules/order-dispatch/cancellation-context"
import { getRefundGateway } from "../modules/order-dispatch/refund-gateway"
import type OrderDispatchModuleService from "../modules/order-dispatch/service"
import { postToStorefront } from "../utils/storefront"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Medusa's own Cancel refunds the captured payment through its Razorpay plugin,
 * which reports success without refunding when it cannot match the payment.
 * So after a cancel that did not come from the customer's own flow, ask
 * Razorpay whether the money really went back, and tell the team if not.
 */
export default async function verifyStockCancelRefundHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [cancellation] = await service.listOrderCancellations({ order_id: data.id }, { take: 1 })
    if (cancellation) {
      // The customer's own cancellation decides its refund and records it.
      return
    }

    const context = await loadCancellationContext(container, data.id)
    if (!context?.has_razorpay_payment) {
      return
    }

    const gateway = getRefundGateway()
    let state = await gateway.paymentRefundState(context.razorpay_payment_id, context.razorpay_order_id)
    // Razorpay can take a moment to show a refund that was just made.
    for (const wait of [3000, 6000]) {
      if (state.status === "known" && state.refunded >= state.amount) {
        return
      }
      await sleep(wait)
      state = await gateway.paymentRefundState(context.razorpay_payment_id, context.razorpay_order_id)
    }
    if (state.status === "known" && state.refunded >= state.amount) {
      return
    }

    logger.error(`[cancel] order ${data.id} was cancelled but its Razorpay payment is not fully refunded`)
    await postToStorefront(
      "/api/ops/notify",
      {
        type: "refund_missing_after_cancel",
        order_id: data.id,
        order_ref: `EYRA-${context.display_id}`,
        amount: state.status === "known" ? state.amount : null,
        refunded: state.status === "known" ? state.refunded : null,
        checked: state.status === "known",
      },
      logger
    )
  } catch (error) {
    logger.error(`[cancel] could not check the refund for cancelled order ${data.id}: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
