/**
 * The reasons a customer can give for a return or exchange. The four codes are
 * what the storefront offers now; the older values stay valid so requests made
 * before are still readable.
 */
export const RETURN_REASON_CODES = ["SIZE_ISSUE", "DESIGN_PREFERENCE", "DAMAGED_IN_TRANSIT", "DEFECTIVE"] as const
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number]

export const LEGACY_REASONS = ["wrong_size", "damaged_or_defective", "not_as_described", "changed_mind", "other"] as const

export const ALL_REASONS = [...RETURN_REASON_CODES, ...LEGACY_REASONS] as const
export type ReturnRequestReason = (typeof ALL_REASONS)[number]

/**
 * Where a request is:
 *
 * - pending:                   waiting for our team (an older request, delivery that could
 *                              not be confirmed, or a reverse pickup that could not be booked)
 * - pending_fee:               an exchange waiting for the ₹99 handling fee (and any price difference) to be paid
 * - reverse_pickup_scheduled:  the courier has been booked to collect the item
 * - awaiting_inspection:       the item reached us and is waiting for the quality check
 * - approved:                  done: the credit was issued (or the replacement sent)
 * - rejected:                  not accepted, or the item failed the quality check
 */
export const RETURN_STATUSES = [
  "pending",
  "pending_fee",
  "reverse_pickup_scheduled",
  "awaiting_inspection",
  "approved",
  "rejected",
] as const
export type ReturnRequestStatus = (typeof RETURN_STATUSES)[number]

/** A request in one of these states is still open and holds its items, so they cannot be requested again. */
export const OPEN_STATUSES: readonly ReturnRequestStatus[] = [
  "pending",
  "pending_fee",
  "reverse_pickup_scheduled",
  "awaiting_inspection",
  "approved",
]

export function isReturnReasonCode(value: unknown): value is ReturnReasonCode {
  return typeof value === "string" && (RETURN_REASON_CODES as readonly string[]).includes(value)
}

/**
 * Reasons for which no reverse logistics fee is charged: the customer did not
 * cause the return. (The older "damaged or defective" value counts too.)
 */
export const FEE_WAIVED_REASONS: readonly string[] = ["DAMAGED_IN_TRANSIT", "DEFECTIVE", "damaged_or_defective"]

/**
 * An exchange starts with no payment at all. The customer only pays when the
 * replacement costs more than what they paid for the item they send back, and then
 * only the difference. Under ₹1 is not worth a payment link and is not charged.
 */
export function exchangePaymentDue(amountDue: number | null | undefined): boolean {
  return Number(amountDue ?? 0) >= 1
}

export function feeWaivedFor(reason: string): boolean {
  return FEE_WAIVED_REASONS.includes(reason)
}
