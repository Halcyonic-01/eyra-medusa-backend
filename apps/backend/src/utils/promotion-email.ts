import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { findDiscountCode } from "./commerce-rules"
import { customerEmailsEnabled, type EmailOutcome } from "./customer-email"
import { sendStorefrontEmail } from "./storefront"

/**
 * Offers and promotions by email, to people who asked for them only.
 *
 * Who asked: customers tagged newsletter_subscriber, which the storefront's
 * signup form sets and its unsubscribe link turns off. An account holder who
 * never signed up gets no offers from here. The storefront has the last say on
 * whether anything is really sent (EMAIL_MODE, EMAIL_PROMOTIONS_ENABLED), so a
 * run from a developer's machine against a test storefront reaches nobody.
 */

export const WELCOME_OFFER_CODE = "WELCOME200"
const STOREFRONT_ORIGIN = "https://www.eyra.org.in"

export type CustomerFacts = {
  id: string
  email: string | null
  first_name: string | null
  metadata: Record<string, unknown> | null
}

export type Offer = { code: string; amount: number; min_order: number }

export const isSubscribed = (customer: Pick<CustomerFacts, "metadata">): boolean => {
  const flag = customer.metadata?.newsletter_subscriber
  return flag === true || flag === "true"
}

export const campaignFlag = (campaign: string): string => `promo_sent_${campaign}`

/** The code as customers are told about it, read from the same rules the cart enforces. */
export function offerFor(code: string): Offer | null {
  const entry = findDiscountCode(code)
  return entry ? { code: entry.code, amount: entry.amount, min_order: entry.min.value } : null
}

/** Subscribers with an address who have not had this campaign yet. */
export function campaignRecipients(customers: readonly CustomerFacts[], campaign: string): CustomerFacts[] {
  return customers.filter(
    (customer) => !!customer.email && isSubscribed(customer) && !customer.metadata?.[campaignFlag(campaign)]
  )
}

async function loadCustomers(container: MedusaContainer, filters: Record<string, unknown> = {}): Promise<CustomerFacts[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const found: CustomerFacts[] = []
  const take = 500
  for (let skip = 0; ; skip += take) {
    const { data } = await query.graph({
      entity: "customer",
      fields: ["id", "email", "first_name", "metadata"],
      filters,
      pagination: { skip, take },
    })
    found.push(...(data as unknown as CustomerFacts[]))
    if (data.length < take) return found
  }
}

async function remember(container: MedusaContainer, customer: CustomerFacts, flag: string): Promise<void> {
  await container.resolve(Modules.CUSTOMER).updateCustomers(customer.id, {
    metadata: { ...(customer.metadata ?? {}), [flag]: new Date().toISOString() },
  })
}

/** True when the customer has placed any order, whatever its state. */
async function hasOrders(container: MedusaContainer, customerId: string): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id"],
    filters: { customer_id: customerId },
    pagination: { skip: 0, take: 1 },
  })
  return data.length > 0
}

/**
 * Sent once, when someone signs up for updates. It talks about a first order,
 * so a customer who has already ordered is on the list but is not sent it.
 * Called when a customer is created and whenever one is updated, since an
 * existing customer who subscribes is only tagged: repeats do nothing.
 */
export async function sendWelcomeOffer(container: MedusaContainer, customerId: string): Promise<EmailOutcome> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!customerEmailsEnabled()) return "disabled"

  try {
    const [customer] = await loadCustomers(container, { id: customerId })
    if (!customer) return "not_found"
    if (!isSubscribed(customer)) return "skipped"
    if (customer.metadata?.welcome_offer_sent_at) return "duplicate"
    if (!customer.email) return "no_email"
    if (await hasOrders(container, customer.id)) return "skipped"

    const offer = offerFor(WELCOME_OFFER_CODE)
    if (!offer) return "skipped"

    const result = await sendStorefrontEmail(
      "/api/wallet/notify",
      {
        type: "welcome_offer",
        email: customer.email,
        first_name: customer.first_name,
        code: offer.code,
        amount: offer.amount,
        min_order: offer.min_order,
        idempotency_key: `welcome-offer:${customer.id}`,
      },
      logger
    )
    if (result === "sent") {
      await remember(container, customer, "welcome_offer_sent_at")
      return "sent"
    }
    return result === "skipped" ? "skipped" : "failed"
  } catch (error) {
    logger.error(`[email] welcome offer for customer ${customerId} failed: ${(error as Error).message}`)
    return "failed"
  }
}

export type CampaignOptions = {
  /** Names the campaign. Each customer gets a given campaign once. Lower case, digits and dashes. */
  campaign: string
  subject: string
  headline: string
  message: string
  ctaLabel: string
  /** A page on the storefront, for example /products. */
  ctaPath: string
  /** A launch discount code to show in the email. */
  code?: string
  /** False (the default in the script) only counts who would get it. */
  send: boolean
  /** Stop after this many sends. */
  limit: number
  /** Pause between sends, since Resend allows about 2 requests a second. */
  delayMs?: number
}

export type CampaignSummary = {
  campaign: string
  mode: "preview" | "send"
  subscribers: number
  already_sent: number
  to_send: number
  sent: number
  failed: number
}

export const CAMPAIGN_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/

export async function runCampaign(container: MedusaContainer, options: CampaignOptions): Promise<CampaignSummary> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!CAMPAIGN_NAME.test(options.campaign)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "campaign must be 2 to 41 characters: lower case letters, digits and dashes"
    )
  }
  const offer = options.code ? offerFor(options.code) : null
  if (options.code && !offer) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `${options.code} is not one of the launch discount codes`)
  }
  if (!options.ctaPath.startsWith("/")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "cta must be a path on the storefront, like /products")
  }

  const customers = await loadCustomers(container)
  const subscribed = customers.filter((customer) => !!customer.email && isSubscribed(customer))
  const pending = campaignRecipients(customers, options.campaign)
  const summary: CampaignSummary = {
    campaign: options.campaign,
    mode: options.send ? "send" : "preview",
    subscribers: subscribed.length,
    already_sent: subscribed.length - pending.length,
    to_send: Math.min(pending.length, options.limit),
    sent: 0,
    failed: 0,
  }
  if (!options.send || !customerEmailsEnabled()) return summary

  for (const customer of pending.slice(0, options.limit)) {
    const result = await sendStorefrontEmail(
      "/api/wallet/notify",
      {
        type: "promotion",
        email: customer.email,
        first_name: customer.first_name,
        subject: options.subject,
        headline: options.headline,
        message: options.message,
        cta_label: options.ctaLabel,
        cta_url: `${STOREFRONT_ORIGIN}${options.ctaPath}`,
        ...(offer ? { code: offer.code, amount: offer.amount, min_order: offer.min_order } : {}),
        idempotency_key: `promo:${options.campaign}:${customer.id}`,
      },
      logger
    )
    if (result === "sent") {
      summary.sent += 1
      await remember(container, customer, campaignFlag(options.campaign))
    } else {
      summary.failed += 1
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 600))
  }
  return summary
}
