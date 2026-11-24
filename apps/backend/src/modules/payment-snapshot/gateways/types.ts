import type { MedusaContainer } from "@medusajs/framework/types"
import type { RefundGateway } from "../../order-dispatch/refund-gateway"

/**
 * What the shared payment logic (paid-price snapshot, duplicate-payment guard,
 * late-payment settle, crash repair, refunds) needs from an online payment
 * provider. Each provider implements it once; nothing shared knows a
 * provider's API or the shape of its session data.
 *
 * An "attempt" is one thing the customer can pay: a Razorpay order, later a
 * PayU transaction. Medusa keeps one payment session per attempt.
 */

/** The provider could not be asked (no keys, timeout, 5xx). The answer is unknown, not "unpaid". */
export class GatewayUnavailableError extends Error {}

/** Money taken: captured. Held but not taken yet: authorized. */
export type GatewayPaymentStatus = "captured" | "authorized" | "pending" | "failed" | "refunded"

export type GatewayPayment = {
  id: string
  /** The attempt the provider says this payment was made against. */
  attempt_ref: string | null
  amount_paise: number
  currency: string
  status: GatewayPaymentStatus
}

export type GatewayAttempt = {
  ref: string
  /** What the attempt asks for, in paise. */
  amount_paise: number
  currency: string
  payments: GatewayPayment[]
  /** The provider's own record, for rebinding a session to it. */
  raw: unknown
}

export interface PrepaidGateway {
  /** Medusa's payment provider id, e.g. pp_razorpay_razorpay. */
  provider_id: string
  /** For people: "Razorpay". */
  name: string
  /** The attempt a Medusa session of this provider pays, from its data. */
  sessionRef(session: { data?: Record<string, unknown> | null } | null | undefined): string | null
  /** The amount the attempt behind a session asks for, in paise (NaN when unknown). */
  sessionAttemptAmount(session: { data?: Record<string, unknown> | null } | null | undefined): number
  /** The attempt and its payments, from the provider. Null when it does not exist. Throws GatewayUnavailableError. */
  fetchAttempt(ref: string): Promise<GatewayAttempt | null>
  /** Points an existing session of this provider at an attempt that is already paid, without opening a new one. */
  rebindSession(container: MedusaContainer, session: { id: string }, attempt: GatewayAttempt, amount: number, currencyCode: string): Promise<void>
  /** Refunds and refund state for payments of this provider. */
  refunds(): RefundGateway
}

const MONEY_TAKEN: GatewayPaymentStatus[] = ["captured", "authorized"]

/** Payments that belong to the attempt itself, in its currency. */
export function ownPayments(attempt: GatewayAttempt): GatewayPayment[] {
  return attempt.payments.filter(
    (payment) => payment.attempt_ref === attempt.ref && payment.currency.toLowerCase() === attempt.currency.toLowerCase()
  )
}

/** What was taken (captured or authorized) towards the attempt, in paise. */
export function paidTowardsAttempt(attempt: GatewayAttempt): number {
  return ownPayments(attempt)
    .filter((payment) => MONEY_TAKEN.includes(payment.status))
    .reduce((sum, payment) => sum + Number(payment.amount_paise), 0)
}
