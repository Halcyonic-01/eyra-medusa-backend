/**
 * How long wallet credit stays usable, in months, counted from the day it is
 * issued. Set WALLET_CREDIT_VALIDITY_MONTHS to change it; 0 means credit never
 * expires. Defaults to 6 months.
 */
export function creditValidityMonths(): number {
  const raw = process.env.WALLET_CREDIT_VALIDITY_MONTHS
  if (raw === undefined || raw.trim() === "") {
    return 6
  }
  const months = Number(raw)
  return Number.isInteger(months) && months >= 0 ? months : 6
}

/** Adds calendar months, clamping to the month's last day (31 Aug + 6 = 28 Feb). */
export function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime())
  const day = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months)
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}

/** When credit issued at `issuedAt` expires, or null when it never does. */
export function creditExpiry(issuedAt: Date): Date | null {
  const months = creditValidityMonths()
  return months === 0 ? null : addMonths(issuedAt, months)
}
