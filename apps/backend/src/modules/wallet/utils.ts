/** Rupees to two decimal places, safe against floating point drift. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** Medusa returns bigNumber columns as numbers or BigNumber objects. */
export function toNumber(value: unknown): number {
  return roundMoney(Number(value ?? 0))
}

/** Reference stamped on cart and order credit lines created by the wallet. */
export const WALLET_CREDIT_LINE_REFERENCE = "wallet"

/** Idempotency key for the ledger row that records a redemption. */
export function redemptionReference(orderId: string): string {
  return `redeem:${orderId}`
}

/** Idempotency key for the ledger row that returns credit after a cancellation. */
export function refundReference(orderId: string): string {
  return `refund:${orderId}`
}

/** Idempotency key for the ledger row that records a batch expiring. */
export function expiryReference(lotId: string): string {
  return `expire:${lotId}`
}
