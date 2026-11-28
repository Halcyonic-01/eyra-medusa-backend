import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { COD_PROVIDER_ID, PAYU_PROVIDER_ID, RAZORPAY_PROVIDER_ID } from "../modules/payment-snapshot/gateways/ids"
import { consentCovers, consentOf } from "./analytics-consent"
import { captureServerEvent, posthogServerConfig } from "./posthog"

/**
 * order_placed and order_cancelled for PostHog, sent exactly once per order.
 *
 * Medusa can announce the same order more than once (the payment repair job
 * re-emits "order placed"), and PostHog does not promise to merge repeats sent
 * in separate requests. So a send is recorded on the order (metadata), under a
 * per-order lock, and a repeat is skipped. A send that fails is left
 * unrecorded, and the analytics backlog job sends it later.
 *
 * Consent first: an event is sent only for a customer whose analytics consent
 * (recorded by the storefront on their profile) was given before the event
 * and is still given now. Checked here, so the subscriber and the backlog job
 * both follow it. No customer, no consent: not sent.
 *
 * Ids, amounts and categories only; no personal data.
 */

export type OrderEventKind = "order_placed" | "order_cancelled"

/** The order metadata key that records a successful send. */
export const SENT_KEY: Record<OrderEventKind, string> = {
  order_placed: "analytics_placed_sent_at",
  order_cancelled: "analytics_cancelled_sent_at",
}

type OrderFacts = {
  id: string
  customer_id?: string | null
  currency_code?: string | null
  total?: unknown
  discount_total?: unknown
  created_at?: string | Date
  canceled_at?: string | Date | null
  metadata?: Record<string, unknown> | null
  items?: ({ quantity?: unknown } | null)[] | null
  credit_lines?: ({ amount?: unknown } | null)[] | null
  payment_collections?: ({ payments?: ({ provider_id?: string | null } | null)[] | null } | null)[] | null
}

/** Medusa returns quantities and amounts as numbers, strings or BigNumber objects ({ numeric } or raw { value }). */
export function num(value: unknown): number {
  if (value && typeof value === "object") {
    const big = value as { numeric?: unknown; value?: unknown }
    return Number(big.numeric ?? big.value ?? 0) || 0
  }
  return Number(value ?? 0) || 0
}

/** How the order was paid, in the storefront's analytics terms. */
export function paymentMethodOf(order: OrderFacts): "razorpay" | "payu" | "cod" | "wallet" | "unknown" {
  const providers = (order.payment_collections ?? []).flatMap((c) => c?.payments ?? []).map((p) => p?.provider_id)
  if (providers.includes(RAZORPAY_PROVIDER_ID)) return "razorpay"
  if (providers.includes(PAYU_PROVIDER_ID)) return "payu"
  const wallet = (order.credit_lines ?? []).reduce((sum, line) => sum + num(line?.amount), 0)
  if (wallet > 0 && num(order.total) - wallet <= 0) return "wallet"
  if (providers.includes(COD_PROVIDER_ID)) return "cod"
  return "unknown"
}

export function orderProperties(order: OrderFacts) {
  const wallet = (order.credit_lines ?? []).reduce((sum, line) => sum + num(line?.amount), 0)
  return {
    order_id: order.id,
    value: num(order.total),
    currency: (order.currency_code ?? "inr").toUpperCase(),
    item_count: (order.items ?? []).reduce((sum, item) => sum + num(item?.quantity), 0),
    payment_method: paymentMethodOf(order),
    has_discount: num(order.discount_total) > 0,
    wallet_credit_used: wallet > 0,
  }
}

const ORDER_FIELDS = [
  "id",
  "customer_id",
  "currency_code",
  "total",
  "discount_total",
  "created_at",
  "canceled_at",
  "metadata",
  // Totals are computed from the items, so their price fields must be loaded too.
  "item_total",
  "shipping_total",
  "items.quantity",
  "items.unit_price",
  "items.detail.quantity",
  "credit_lines.amount",
  "payment_collections.payments.provider_id",
]

export type OrderEventResult = "sent" | "already_sent" | "not_applicable" | "no_consent" | "off" | "failed"

/** Sends one order event unless it was already sent. Never throws. */
export async function sendOrderEvent(container: MedusaContainer, orderId: string, kind: OrderEventKind): Promise<OrderEventResult> {
  if (!posthogServerConfig()) return "off"
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  let result: OrderEventResult = "failed"
  try {
    // The lock stops the subscriber and the backlog job sending the same order at once.
    await container.resolve(Modules.LOCKING).execute(
      [`analytics:${kind}:${orderId}`],
      async () => {
        result = await sendLocked(container, orderId, kind, logger)
      },
      { timeout: 5 }
    )
  } catch (error) {
    // Analytics never affects an order.
    logger.warn(`[analytics] ${kind} for ${orderId} not sent: ${(error as Error).message}`)
  }
  return result
}

async function sendLocked(
  container: MedusaContainer,
  orderId: string,
  kind: OrderEventKind,
  logger: { warn: (message: string) => void }
): Promise<OrderEventResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ORDER_FIELDS, filters: { id: orderId } })
  const order = data[0] as OrderFacts | undefined
  if (!order) return "not_applicable"
  if (kind === "order_cancelled" && !order.canceled_at) return "not_applicable"
  if (order.metadata?.[SENT_KEY[kind]]) return "already_sent"

  const placed = kind === "order_placed"
  const eventAt = new Date((placed ? order.created_at : order.canceled_at) ?? Date.now())
  if (!(await customerConsents(container, order.customer_id, eventAt))) return "no_consent"

  const outcome = await captureServerEvent(
    {
      event: kind,
      distinctId: order.customer_id ?? null,
      dedupeKey: `${kind}:${order.id}`,
      timestamp: eventAt,
      properties: orderProperties(order),
    },
    logger
  )
  if (outcome !== "sent") return outcome
  // Medusa merges metadata, so the order's other keys are kept.
  await container.resolve(Modules.ORDER).updateOrders({ id: order.id }, { metadata: { [SENT_KEY[kind]]: new Date().toISOString() } })
  return "sent"
}

/** The customer's consent, read fresh each time so a withdrawal applies to events still waiting. */
async function customerConsents(container: MedusaContainer, customerId: string | null | undefined, eventAt: Date): Promise<boolean> {
  if (!customerId) return false
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "customer", fields: ["id", "metadata"], filters: { id: customerId } })
  const customer = data[0] as { metadata?: Record<string, unknown> | null } | undefined
  return consentCovers(consentOf(customer?.metadata), eventAt)
}
