import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ORDER_DISPATCH_MODULE } from "../modules/order-dispatch"
import type OrderDispatchModuleService from "../modules/order-dispatch/service"
import { PRODUCT_REVIEW_MODULE } from "../modules/product-review"
import { REVIEW_LINK_DAYS } from "../modules/product-review/constants"
import type ProductReviewModuleService from "../modules/product-review/service"
import { requestOrderReviewsWorkflow, sendReviewNotificationsWorkflow } from "../workflows/request-order-reviews"

/**
 * Every ten minutes:
 *  - opens the review request for any order delivered in the last 30 days that
 *    has none (a delivery update that came while something was down), and
 *  - sends every review message that is due: reminders whose three days are
 *    up, and retries of messages that failed. A reminder is cancelled when the
 *    customer has already reviewed. Nothing is ever sent twice.
 */
export default async function sendReviewRequests(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const since = new Date(Date.now() - REVIEW_LINK_DAYS * 24 * 3600 * 1000)
  try {
    const dispatches: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const reviews: ProductReviewModuleService = container.resolve(PRODUCT_REVIEW_MODULE)
    const delivered = await dispatches.listOrderDispatches(
      { delivered_at: { $gte: since }, rto_delivered_at: null } as any,
      { select: ["order_id"], take: 200, order: { delivered_at: "DESC" } }
    )
    const orderIds = [...new Set(delivered.map((row: any) => row.order_id as string).filter(Boolean))]
    if (orderIds.length) {
      const known = new Set((await reviews.listReviewRequests({ order_id: orderIds }, { select: ["order_id"], take: orderIds.length })).map((r: any) => r.order_id))
      for (const orderId of orderIds.filter((id) => !known.has(id))) {
        const { errors } = await requestOrderReviewsWorkflow(container).run({ input: { order_id: orderId }, throwOnError: false })
        if (errors?.length) logger.error(`[reviews] could not open the review request for ${orderId}: ${(errors[0].error as Error)?.message}`)
      }
    }
  } catch (error) {
    logger.error(`[reviews] could not look for delivered orders: ${(error as Error).message}`)
  }

  const { result, errors } = await sendReviewNotificationsWorkflow(container).run({ throwOnError: false })
  if (errors?.length) {
    logger.error(`[reviews] review messages not sent this run: ${(errors[0].error as Error)?.message}`)
    return
  }
  if (result && (result.sent || result.failed || result.gave_up)) {
    logger.info(`[reviews] review messages: ${result.sent} sent, ${result.failed} failed, ${result.gave_up} given up, ${result.cancelled} cancelled`)
  }
}

export const config = {
  name: "send-review-requests",
  schedule: "*/10 * * * *",
}
