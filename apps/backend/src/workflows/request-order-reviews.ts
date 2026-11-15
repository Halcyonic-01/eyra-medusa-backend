import { createWorkflow, transform, when, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { openReviewRequestStep, sendDueReviewNotificationsStep } from "./steps/review-notifications"

/**
 * When an order is delivered: open its review request (once) and send the
 * email and, with the customer's consent, the WhatsApp message straight away.
 * The reminder waits three days; the scheduled job sends it, and retries any
 * message that failed now.
 */
export const requestOrderReviewsWorkflow = createWorkflow("request-order-reviews", function (input: { order_id: string }) {
  const opened = openReviewRequestStep({ order_id: input.order_id })
  const requestIds = transform({ opened }, (data) => (data.opened.request_id ? [data.opened.request_id] : []))
  const sent = when("send-review-request-now", { requestIds }, (data) => data.requestIds.length > 0).then(() =>
    sendDueReviewNotificationsStep({ request_ids: requestIds })
  )
  return new WorkflowResponse({ opened, sent })
})

/** The scheduled job: every message that is due, and nothing that is not. */
export const sendReviewNotificationsWorkflow = createWorkflow("send-review-notifications", function () {
  const counts = sendDueReviewNotificationsStep({ all: true })
  return new WorkflowResponse(counts)
})
