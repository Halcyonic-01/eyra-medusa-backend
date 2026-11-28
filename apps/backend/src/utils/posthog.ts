import crypto from "node:crypto"

/**
 * Server-side product analytics: the few events only the backend knows for
 * certain (an order placed or cancelled, whichever way it happened: browser,
 * webhook or reconciliation sweep). One HTTP call to PostHog's capture
 * endpoint per event; no SDK, no queue, no retries.
 *
 * Off unless POSTHOG_PROJECT_TOKEN is set. Never throws: an analytics failure
 * is logged and dropped, and never affects an order.
 */

type Env = Record<string, string | undefined>

const HOSTS = ["https://us.i.posthog.com", "https://eu.i.posthog.com"]

export type PosthogServerConfig = { token: string; host: string }

/** Null when off. The token is the project token (phc_), the same public one the storefront uses. */
export function posthogServerConfig(env: Env = process.env): PosthogServerConfig | null {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim() ?? ""
  if (!/^phc_[A-Za-z0-9]{10,}$/.test(token)) return null
  const host = (env.POSTHOG_HOST?.trim() || "https://eu.i.posthog.com").replace(/\/+$/, "")
  return HOSTS.includes(host) ? { token, host } : null
}

/**
 * A stable UUID for an event, so the same fact sent twice is one event in
 * PostHog where it de-duplicates by uuid. Formatted as a version-5 style UUID
 * from a SHA-256 of the name.
 */
export function eventUuid(name: string): string {
  const hex = crypto.createHash("sha256").update(name).digest("hex")
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export type ServerEvent = {
  event: string
  /** The person: the Medusa customer id (cus_…), the id the storefront identifies them with. */
  distinctId: string | null
  /** Unique per fact, e.g. "order_placed:order_123". */
  dedupeKey: string
  timestamp: Date
  properties: Record<string, string | number | boolean | null>
}

type Logger = { warn: (message: string) => void }

export async function captureServerEvent(
  input: ServerEvent,
  logger: Logger,
  config: PosthogServerConfig | null = posthogServerConfig()
): Promise<"sent" | "off" | "failed"> {
  if (!config) return "off"
  // No customer: still counted, under the order, without creating a person.
  const distinctId = input.distinctId && /^cus_[A-Za-z0-9]+$/.test(input.distinctId) ? input.distinctId : input.dedupeKey
  try {
    const res = await fetch(`${config.host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.token,
        event: input.event,
        distinct_id: distinctId,
        uuid: eventUuid(input.dedupeKey),
        timestamp: input.timestamp.toISOString(),
        properties: {
          ...input.properties,
          $lib: "eyra-backend",
          ...(distinctId === input.distinctId ? {} : { $process_person_profile: false }),
        },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      logger.warn(`[analytics] PostHog answered ${res.status} for ${input.event}`)
      return "failed"
    }
    return "sent"
  } catch (error) {
    logger.warn(`[analytics] could not send ${input.event}: ${(error as Error).message}`)
    return "failed"
  }
}
