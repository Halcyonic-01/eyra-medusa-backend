import { callStorefront } from "./storefront"

/**
 * A WhatsApp message to a customer, through the provider the storefront has set
 * up (WATI or AiSensy: the storefront holds its keys). Never throws, and never
 * blocks what it announces: a message not sent is logged and that is all.
 */

export type WhatsappTemplate = "store_credit_issued" | "exchange_payment_link" | "replacement_dispatched"

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

export async function sendWhatsapp(
  log: { info: (message: string) => void; error: (message: string) => void },
  message: WhatsappMessage
): Promise<boolean> {
  const number = whatsappNumber(message.phone)
  if (!number) {
    log.info(`[whatsapp] no usable phone number, skipping ${message.template}`)
    return false
  }
  const reply = await callStorefront(
    "/api/whatsapp/send",
    { template: message.template, phone: number, name: message.name ?? null, params: message.params },
    { timeoutMs: 15000 }
  )
  if (reply.kind !== "answered") {
    log.error(`[whatsapp] could not reach the storefront for ${message.template}: ${reply.message}`)
    return false
  }
  if (reply.status !== 200 || reply.body?.sent !== true) {
    log.info(`[whatsapp] ${message.template} not sent: ${String(reply.body?.error ?? reply.body?.skipped ?? reply.status)}`)
    return false
  }
  return true
}
