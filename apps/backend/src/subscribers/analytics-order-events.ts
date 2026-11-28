import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { sendOrderEvent } from "../utils/analytics-orders"

/**
 * order_placed and order_cancelled for PostHog, sent from here because only
 * the backend sees every order, however it was placed (the customer's browser,
 * a webhook, or the sweep that recovers missed payments). Each is sent once
 * per order, however often Medusa announces it (see sendOrderEvent).
 */
export default async function analyticsOrderEvents({ event, container }: SubscriberArgs<{ id: string }>) {
  await sendOrderEvent(container, event.data.id, event.name === "order.placed" ? "order_placed" : "order_cancelled")
}

export const config: SubscriberConfig = {
  event: ["order.placed", "order.canceled"],
}
