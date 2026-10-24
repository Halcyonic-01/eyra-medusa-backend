import { MedusaError } from "@medusajs/framework/utils"

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid request: ${message}`)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("query must be an object")
  return value as Record<string, unknown>
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export type ListCreditNotesQuery = { order_id?: string; month?: string; limit: number; offset: number }

export function parseListCreditNotes(query: unknown): ListCreditNotesQuery {
  const source = asRecord(query)
  const orderId = source.order_id
  if (orderId !== undefined && (typeof orderId !== "string" || !orderId.startsWith("order_"))) {
    invalid("'order_id' must be an order id")
  }
  const month = source.month
  if (month !== undefined && (typeof month !== "string" || !MONTH.test(month))) invalid("'month' must look like 2026-10")
  const number = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) invalid("'limit' and 'offset' must be whole numbers in range")
    return parsed
  }
  return {
    order_id: orderId as string | undefined,
    month: month as string | undefined,
    limit: number(source.limit, 50, 200),
    offset: number(source.offset, 0, 100000),
  }
}

export type Gstr1Query = { month: string }

export function parseGstr1(query: unknown): Gstr1Query {
  const month = asRecord(query).month
  if (typeof month !== "string" || !MONTH.test(month)) invalid("'month' must look like 2026-10")
  return { month }
}
