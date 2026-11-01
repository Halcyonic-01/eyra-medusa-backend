import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { sendStorefrontEmail } from "./storefront"

/**
 * Order emails to customers. The storefront owns the wording and the Resend
 * account (see /api/wallet/notify there); this decides when one goes out and
 * makes sure each goes out once per order.
 *
 * "Once" has two layers: the order remembers it in metadata (email_sent_<key>)
 * so a repeated courier update or a retried step sends nothing, and the
 * storefront passes <key>:<order id> to Resend as an idempotency key so two
 * calls at the same moment still produce one email.
 *
 * Nothing here throws. A customer email is never worth failing an order for.
 */
export type EmailOutcome = "sent" | "duplicate" | "skipped" | "no_email" | "not_found" | "disabled" | "failed"

type Env = Record<string, string | undefined>

/** CUSTOMER_EMAILS_ENABLED=false stops the backend asking for any order email. */
export function customerEmailsEnabled(env: Env = process.env): boolean {
  return env.CUSTOMER_EMAILS_ENABLED?.trim().toLowerCase() !== "false"
}

export const sentFlag = (key: string): string => `email_sent_${key}`

export function alreadySent(metadata: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(metadata?.[sentFlag(key)])
}

export type OrderFacts = {
  id: string
  display_id: number
  email: string | null
  first_name: string | null
  metadata: Record<string, unknown> | null
}

/** The body sent to the storefront: who, which order, and what the caller adds. */
export function orderEmailBody(order: OrderFacts, key: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    ...fields,
    email: order.email,
    first_name: order.first_name,
    order_id: order.id,
    order_number: order.display_id,
    idempotency_key: `${key}:${order.id}`,
  }
}

export async function loadOrderFacts(container: MedusaContainer, orderId: string): Promise<OrderFacts | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "email", "metadata", "shipping_address.first_name"],
    filters: { id: orderId },
  })
  const order = data[0] as unknown as
    | { id: string; display_id: number; email?: string | null; metadata?: Record<string, unknown> | null; shipping_address?: { first_name?: string | null } | null }
    | undefined
  if (!order) return null
  return {
    id: order.id,
    display_id: order.display_id,
    email: order.email ?? null,
    first_name: order.shipping_address?.first_name ?? null,
    metadata: order.metadata ?? null,
  }
}

/**
 * Sends one kind of email for an order, once. `fields` carries the storefront
 * message type and whatever that message shows; return null from it to send
 * nothing.
 */
export async function sendOrderEmailOnce(
  container: MedusaContainer,
  orderId: string,
  key: string,
  fields: (order: OrderFacts) => Record<string, unknown> | null
): Promise<EmailOutcome> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!customerEmailsEnabled()) return "disabled"

  try {
    const order = await loadOrderFacts(container, orderId)
    if (!order) return "not_found"
    if (alreadySent(order.metadata, key)) return "duplicate"
    if (!order.email) return "no_email"

    const extra = fields(order)
    if (!extra) return "skipped"

    const result = await sendStorefrontEmail("/api/wallet/notify", orderEmailBody(order, key, extra), logger)
    if (result === "sent") {
      // Only keys sent here are written: the order module merges them into the rest.
      await container.resolve(Modules.ORDER).updateOrders(
        { id: orderId },
        { metadata: { [sentFlag(key)]: new Date().toISOString() } }
      )
      return "sent"
    }
    if (result === "failed") {
      logger.error(`[email] ${key} email for order ${orderId} was not sent`)
    }
    return result === "skipped" ? "skipped" : "failed"
  } catch (error) {
    logger.error(`[email] ${key} email for order ${orderId} failed: ${(error as Error).message}`)
    return "failed"
  }
}
