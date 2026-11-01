import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { sendWelcomeOffer } from "../utils/promotion-email"

/**
 * Sends the welcome discount code to someone who signs up for updates on the
 * storefront. A new signup creates a customer tagged newsletter_subscriber; an
 * existing customer who signs up is tagged by an update. Other customers are
 * left alone, and so are customers who have already ordered. Sent once.
 */
export default async function sendWelcomeOfferHandler({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  await sendWelcomeOffer(container, data.id)
}

export const config: SubscriberConfig = {
  event: ["customer.created", "customer.updated"],
}
