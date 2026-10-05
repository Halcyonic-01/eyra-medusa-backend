import { MedusaError } from "@medusajs/framework/utils"

/**
 * Request validation for the wallet routes.
 *
 * Medusa's own Zod middleware only formats errors correctly for schemas built
 * with the copy of Zod bundled inside the framework, and this project pins a
 * different Zod. Plain parsers that throw INVALID_DATA give the same 400
 * response without depending on either copy.
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

function requiredId(source: Record<string, unknown>, field: string, prefix: string): string {
  const value = source[field]
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length) {
    invalid(`'${field}' must be an id starting with '${prefix}'`)
  }
  return value as string
}

function optionalId(
  source: Record<string, unknown>,
  field: string,
  prefix: string
): string | undefined {
  if (source[field] === undefined || source[field] === null || source[field] === "") {
    return undefined
  }
  return requiredId(source, field, prefix)
}

function boundedInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === "") {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid(`'${field}' must be a whole number between ${min} and ${max}`)
  }
  return parsed
}

export const MAX_CREDIT_AMOUNT = 1000000

export type IssueWalletCreditBody = {
  customer_id: string
  amount: number
  reason: "return" | "exchange"
  order_id?: string
  note?: string
}

export function parseIssueWalletCredit(body: unknown): IssueWalletCreditBody {
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

  const reason = source.reason
  if (reason !== "return" && reason !== "exchange") {
    invalid("'reason' must be 'return' or 'exchange'")
  }

  let note: string | undefined
  if (source.note !== undefined && source.note !== null) {
    if (typeof source.note !== "string") {
      invalid("'note' must be text")
    }
    note = (source.note as string).trim() || undefined
    if (note && note.length > 500) {
      invalid("'note' can be at most 500 characters")
    }
  }

  return {
    customer_id: requiredId(source, "customer_id", "cus_"),
    amount: amount as number,
    reason: reason as "return" | "exchange",
    order_id: optionalId(source, "order_id", "order_"),
    note,
  }
}

export type ApplyWalletToCartBody = {
  cart_id: string
  customer_id: string
}

export function parseApplyWalletToCart(body: unknown): ApplyWalletToCartBody {
  const source = asRecord(body, "body")
  return {
    cart_id: requiredId(source, "cart_id", "cart_"),
    customer_id: requiredId(source, "customer_id", "cus_"),
  }
}

export type GetWalletsQuery = {
  customer_id?: string
  limit: number
  offset: number
}

export function parseGetWallets(query: unknown): GetWalletsQuery {
  const source = asRecord(query ?? {}, "query")
  return {
    customer_id: optionalId(source, "customer_id", "cus_"),
    limit: boundedInt(source.limit, "limit", 20, 1, 100),
    offset: boundedInt(source.offset, "offset", 0, 0, 1000000),
  }
}
