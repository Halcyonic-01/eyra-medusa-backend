/**
 * The customer's analytics choice, recorded by the storefront on their Medusa
 * profile (metadata.analytics_consent) when they accept, decline or withdraw.
 * Server-side order events follow it: sent only for a customer who said yes.
 */

export const CONSENT_KEY = "analytics_consent"
/** Must match the storefront's CONSENT_VERSION (lib/analytics/consent.ts). */
export const CONSENT_VERSION = 1

export type AnalyticsConsent = { status: "granted" | "denied"; at: Date; version: number }

export function consentOf(metadata: Record<string, unknown> | null | undefined): AnalyticsConsent | null {
  const raw = metadata?.[CONSENT_KEY] as { status?: unknown; at?: unknown; version?: unknown } | undefined
  if (!raw || typeof raw !== "object") return null
  if (raw.status !== "granted" && raw.status !== "denied") return null
  if (raw.version !== CONSENT_VERSION || typeof raw.at !== "string") return null
  const at = new Date(raw.at)
  if (Number.isNaN(at.getTime())) return null
  return { status: raw.status, at, version: raw.version }
}

/**
 * Whether an event that happened at `eventAt` may be sent: the customer's
 * current choice is "granted" and was given at or before the event. So:
 * - no choice, or "denied": never sent
 * - withdrawn later: nothing more is sent, including events still waiting in the backlog
 * - consent is not retroactive: an order placed before the customer accepted is not sent
 */
export function consentCovers(consent: AnalyticsConsent | null, eventAt: Date): boolean {
  return consent?.status === "granted" && consent.at.getTime() <= eventAt.getTime()
}
