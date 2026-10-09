import { MedusaError } from "@medusajs/framework/utils"
import {
  CANCEL_REASONS,
  isCancelReason,
  type CancelReason,
  type RefundMethod,
} from "../../../modules/order-dispatch/cancellation"

/**
 * Request validation for the order cancellation routes, as plain parsers (see
 * the note in the wallet routes on why not Zod).
 */

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function customerId(source: Record<string, unknown>): string {
  const value = source.customer_id
  if (typeof value !== "string" || !value.startsWith("cus_") || value.length <= 4) {
    invalid("'customer_id' must be a customer id")
  }
  return value as string
}

export type CancellationPreviewQuery = { customer_id: string }

export function parseCancellationPreview(query: unknown): CancellationPreviewQuery {
  return { customer_id: customerId(asRecord(query, "query")) }
}

export type CancelOrderBody = {
  customer_id: string
  refund_method?: RefundMethod
  reason: CancelReason
  note?: string
}

export function parseCancelOrder(body: unknown): CancelOrderBody {
  const source = asRecord(body, "body")

  if (!isCancelReason(source.reason)) {
    invalid(`'reason' must be one of ${CANCEL_REASONS.join(", ")}`)
  }

  let refundMethod: RefundMethod | undefined
  if (source.refund_method !== undefined && source.refund_method !== null && source.refund_method !== "") {
    if (source.refund_method !== "wallet" && source.refund_method !== "original") {
      invalid("'refund_method' must be 'wallet' or 'original'")
    }
    refundMethod = source.refund_method as RefundMethod
  }

  let note: string | undefined
  if (source.note !== undefined && source.note !== null) {
    if (typeof source.note !== "string" || source.note.length > 500) {
      invalid("'note' must be text of at most 500 characters")
    }
    note = (source.note as string).trim() || undefined
  }

  return {
    customer_id: customerId(source),
    refund_method: refundMethod,
    reason: source.reason as CancelReason,
    note,
  }
}
