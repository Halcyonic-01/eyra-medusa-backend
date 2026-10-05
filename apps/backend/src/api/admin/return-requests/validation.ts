import { MedusaError } from "@medusajs/framework/utils"
import { MAX_CREDIT_AMOUNT } from "../wallets/validation"

/** Request validation for the return and exchange request routes. */

const TYPES = ["return", "exchange"] as const
const REASONS = [
  "wrong_size",
  "damaged_or_defective",
  "not_as_described",
  "changed_mind",
  "other",
] as const
const STATUSES = ["pending", "approved", "rejected"] as const

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function id(source: Record<string, unknown>, field: string, prefix: string): string {
  const value = source[field]
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length) {
    invalid(`'${field}' must be an id starting with '${prefix}'`)
  }
  return value as string
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`'${field}' must be one of: ${allowed.join(", ")}`)
  }
  return value as T
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string") {
    invalid(`'${field}' must be text`)
  }
  const trimmed = (value as string).trim()
  if (trimmed.length > max) {
    invalid(`'${field}' can be at most ${max} characters`)
  }
  return trimmed || undefined
}

export type CreateReturnRequestBody = {
  customer_id: string
  order_id: string
  type: (typeof TYPES)[number]
  reason: (typeof REASONS)[number]
  note?: string
  items: { item_id: string; quantity: number }[]
}

export function parseCreateReturnRequest(body: unknown): CreateReturnRequestBody {
  const source = asRecord(body, "body")

  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 50) {
    invalid("'items' must list between 1 and 50 items")
  }
  const items = (source.items as unknown[]).map((entry, index) => {
    const row = asRecord(entry, `items[${index}]`)
    const quantity = row.quantity
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      invalid(`items[${index}].quantity must be a whole number of at least 1`)
    }
    return { item_id: id(row, "item_id", "ordli_"), quantity: quantity as number }
  })

  return {
    customer_id: id(source, "customer_id", "cus_"),
    order_id: id(source, "order_id", "order_"),
    type: oneOf(source.type, "type", TYPES),
    reason: oneOf(source.reason, "reason", REASONS),
    note: text(source.note, "note", 1000),
    items,
  }
}

export type ApproveReturnRequestBody = {
  amount: number
  note?: string
}

export function parseApproveReturnRequest(body: unknown): ApproveReturnRequestBody {
  const source = asRecord(body, "body")

  const amount = source.amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    invalid("'amount' must be a number greater than 0")
  }
  if ((amount as number) > MAX_CREDIT_AMOUNT) {
    invalid(`'amount' can be at most ${MAX_CREDIT_AMOUNT}`)
  }
  if (Math.abs((amount as number) * 100 - Math.round((amount as number) * 100)) > 1e-6) {
    invalid("'amount' can have at most two decimal places")
  }

  return { amount: amount as number, note: text(source.note, "note", 500) }
}

export type RejectReturnRequestBody = {
  note: string
}

export function parseRejectReturnRequest(body: unknown): RejectReturnRequestBody {
  const source = asRecord(body, "body")
  const note = text(source.note, "note", 500)
  if (!note) {
    invalid("'note' is required, so the customer knows why")
  }
  return { note: note as string }
}

export type ListReturnRequestsQuery = {
  customer_id?: string
  order_id?: string
  status?: (typeof STATUSES)[number]
  limit: number
  offset: number
}

export function parseListReturnRequests(query: unknown): ListReturnRequestsQuery {
  const source = asRecord(query ?? {}, "query")
  const optionalId = (field: string, prefix: string) =>
    source[field] === undefined || source[field] === "" ? undefined : id(source, field, prefix)

  const bounded = (field: string, fallback: number, min: number, max: number) => {
    const value = source[field]
    if (value === undefined || value === "") {
      return fallback
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      invalid(`'${field}' must be a whole number between ${min} and ${max}`)
    }
    return parsed
  }

  return {
    customer_id: optionalId("customer_id", "cus_"),
    order_id: optionalId("order_id", "order_"),
    status:
      source.status === undefined || source.status === ""
        ? undefined
        : oneOf(source.status, "status", STATUSES),
    limit: bounded("limit", 20, 1, 100),
    offset: bounded("offset", 0, 0, 1000000),
  }
}
