import type { SubscriberArgs, SubscriberConfig } from "@medusajs/medusa"

/**
 * Notifies the storefront to revalidate its ISR cache whenever a product,
 * variant, or price changes in the admin. Without this, edits only show up
 * once the storefront's 60s time-based revalidation window happens to expire.
 *
 * Requires STOREFRONT_REVALIDATE_URL and STOREFRONT_REVALIDATE_SECRET — this
 * is a no-op (not an error) when either is unset.
 */
export default async function revalidateStorefrontHandler({
  event,
}: SubscriberArgs<unknown>) {
  const url = process.env.STOREFRONT_REVALIDATE_URL
  const secret = process.env.STOREFRONT_REVALIDATE_SECRET
  if (!url || !secret) return

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ tag: "products", event: event.name }),
    })
    if (!res.ok) {
      console.error(
        `[revalidate-storefront] storefront returned ${res.status} for event ${event.name}`
      )
    }
  } catch (err) {
    console.error(
      `[revalidate-storefront] failed to notify storefront for event ${event.name}:`,
      err
    )
  }
}

export const config: SubscriberConfig = {
  event: [
    "product.product.created",
    "product.product.updated",
    "product.product.deleted",
    "product.product-variant.created",
    "product.product-variant.updated",
    "product.product-variant.deleted",
    "pricing.price.created",
    "pricing.price.updated",
    "pricing.price.deleted",
    "pricing.price-set.updated",
  ],
}
