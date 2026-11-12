import crypto from "node:crypto"

/**
 * Pure helpers for the guard in front of Medusa's own Razorpay webhook
 * (/hooks/payment/razorpay_razorpay).
 *
 * Why it exists: the Razorpay plugin finds the Medusa payment session through
 * `payment.notes.session_id`, which EYRA's checkout never sets (and which, being
 * written by the browser at checkout, could not be trusted anyway). Medusa then
 * runs its payment workflow with no session at all, and its queries treat that
 * as "no filter": tests showed it capturing another order's payment and
 * completing an abandoned Cash on Delivery cart. The guard puts the right
 * session in from the backend's own record, or stops the event.
 */

/** The only events the plugin turns into a Medusa payment action we want. */
export const HANDLED_EVENTS = ["payment.captured", "payment.authorized"]

/** Razorpay's signature: HMAC-SHA256 of the exact bytes received, hex. */
export function webhookSignatureValid(rawBody: Buffer | string | undefined, signature: unknown, secret: string): boolean {
  if (!rawBody || typeof signature !== "string" || !signature || !secret) return false
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"), "hex")
  const given = Buffer.from(signature, "hex")
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

export type WebhookTarget = { event: string; razorpay_order_id: string; razorpay_payment_id: string | null }

/** The event name and the Razorpay order it concerns, or null when there is nothing to act on. */
export function webhookTarget(body: unknown): WebhookTarget | null {
  const data = body as { event?: unknown; payload?: { payment?: { entity?: { id?: unknown; order_id?: unknown } } } } | null
  const event = typeof data?.event === "string" ? data.event : ""
  const entity = data?.payload?.payment?.entity
  const orderId = typeof entity?.order_id === "string" && entity.order_id ? entity.order_id : null
  if (!HANDLED_EVENTS.includes(event) || !orderId) return null
  return {
    event,
    razorpay_order_id: orderId,
    razorpay_payment_id: typeof entity?.id === "string" ? entity.id : null,
  }
}

/**
 * Writes the backend's own session id into the parsed event, replacing anything
 * the browser put in the notes. Only the parsed body changes: the raw bytes the
 * plugin checks the signature against are left exactly as Razorpay sent them.
 */
export function withSessionId(body: unknown, sessionId: string): void {
  const entity = (body as { payload: { payment: { entity: { notes?: unknown } } } }).payload.payment.entity
  const notes = entity.notes && typeof entity.notes === "object" && !Array.isArray(entity.notes) ? (entity.notes as Record<string, unknown>) : {}
  entity.notes = { ...notes, session_id: sessionId }
}

/** The webhook secret, read the same way medusa-config passes it to the plugin. */
export function razorpayWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAZORPAY_TEST_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET || ""
}
