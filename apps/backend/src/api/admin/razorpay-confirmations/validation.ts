import { MedusaError } from "@medusajs/framework/utils"

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function idField(body: Record<string, unknown>, key: string, prefix: string): string {
  const value = body[key]
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 100) invalid(`'${key}' must be a ${prefix} id`)
  return value as string
}

export type RazorpayConfirmationBody = { cart_id: string; razorpay_order_id: string; razorpay_payment_id: string }

export function parseRazorpayConfirmation(body: unknown): RazorpayConfirmationBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("body must be an object")
  const record = body as Record<string, unknown>
  return {
    cart_id: idField(record, "cart_id", "cart_"),
    razorpay_order_id: idField(record, "razorpay_order_id", "order_"),
    razorpay_payment_id: idField(record, "razorpay_payment_id", "pay_"),
  }
}

export type ConfirmationEmailBody = { action: "claim" | "sent" | "release" }

export function parseConfirmationEmail(body: unknown): ConfirmationEmailBody {
  const action = (body as { action?: unknown } | null)?.action
  if (action !== "claim" && action !== "sent" && action !== "release") invalid("'action' must be claim, sent or release")
  return { action: action as ConfirmationEmailBody["action"] }
}

export type DispatchOverrideBody = { reason: string }

export function parseDispatchOverride(body: unknown): DispatchOverrideBody {
  const reason = (body as { reason?: unknown } | null)?.reason
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
    invalid("'reason' must say why, in 10 to 500 characters")
  }
  return { reason: (reason as string).trim() }
}
