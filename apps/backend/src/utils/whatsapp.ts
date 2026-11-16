import { callStorefront } from "./storefront"

/**
 * A WhatsApp message to a customer, through the provider the storefront has set
 * up (WATI or AiSensy: the storefront holds its keys). Never throws, and never
 * blocks what it announces: a message not sent is logged and that is all.
 */

export type WhatsappTemplate =
  | "store_credit_issued"
  | "exchange_payment_link"
  | "replacement_dispatched"
  | "review_request"
  | "review_reminder"

export type WhatsappMessage = {
  template: WhatsappTemplate
  /** The customer's phone as saved on the order. */
  phone: string | null | undefined
  name?: string | null
  params: Record<string, string | number>
}

/** 10 digits, with or without +91 or a leading 0, as +91XXXXXXXXXX. Null when it is not an Indian mobile number. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "")
  const ten = digits.length >= 10 ? digits.slice(-10) : ""
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null
}

export type WhatsappOutcome =
  | { result: "sent" }
  | { result: "skipped"; detail: string }
  | { result: "failed"; detail: string }

/**
 * Sends one message and says what happened: sent, skipped (no usable number, or
 * no provider set up, which a retry cannot fix) or failed (worth trying again).
 */
export async function sendWhatsappOutcome(
  log: { info: (message: string) => void; error: (message: string) => void },
  message: WhatsappMessage
): Promise<WhatsappOutcome> {
  const number = whatsappNumber(message.phone)
  if (!number) {
    log.info(`[whatsapp] no usable phone number, skipping ${message.template}`)
    return { result: "skipped", detail: "no_phone" }
  }
  const reply = await callStorefront(
    "/api/whatsapp/send",
    { template: message.template, phone: number, name: message.name ?? null, params: message.params },
    { timeoutMs: 15000 }
  )
  if (reply.kind === "skipped") return { result: "skipped", detail: "storefront_not_configured" }
  if (reply.kind !== "answered") {
    log.error(`[whatsapp] could not reach the storefront for ${message.template}: ${reply.message}`)
    return { result: "failed", detail: "storefront_unreachable" }
  }
  if (reply.status === 200 && reply.body?.sent === true) return { result: "sent" }
  if (reply.status === 503 || reply.body?.skipped) {
    return { result: "skipped", detail: String(reply.body?.skipped ?? reply.body?.error ?? "not_configured") }
  }
  log.info(`[whatsapp] ${message.template} not sent: ${String(reply.body?.error ?? reply.status)}`)
  return { result: "failed", detail: String(reply.body?.error ?? `status_${reply.status}`).slice(0, 200) }
}

export async function sendWhatsapp(
  log: { info: (message: string) => void; error: (message: string) => void },
  message: WhatsappMessage
): Promise<boolean> {
  return (await sendWhatsappOutcome(log, message)).result === "sent"
}
