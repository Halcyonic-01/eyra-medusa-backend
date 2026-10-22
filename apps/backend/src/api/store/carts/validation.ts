import { MedusaError } from "@medusajs/framework/utils"
import type { PaymentMode } from "../../../utils/commerce-rules"

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("body must be an object")
  }
  return value as Record<string, unknown>
}

export type PaymentModeBody = { mode: PaymentMode }

export function parsePaymentMode(body: unknown): PaymentModeBody {
  const mode = asRecord(body).mode
  if (mode !== "prepaid" && mode !== "cod") {
    invalid("'mode' must be 'prepaid' or 'cod'")
  }
  return { mode: mode as PaymentMode }
}

export type DiscountCodeBody = { code: string | null }

export function parseDiscountCode(body: unknown): DiscountCodeBody {
  const code = asRecord(body).code
  if (code === null || code === undefined || code === "") {
    return { code: null }
  }
  if (typeof code !== "string" || code.length > 40) {
    invalid("'code' must be text of at most 40 characters")
  }
  return { code: (code as string).trim() }
}
