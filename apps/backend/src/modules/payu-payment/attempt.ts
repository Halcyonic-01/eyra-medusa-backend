import { PAYU_PROVIDER_ID } from "../payment-snapshot/gateways/ids"
import type { GatewayAttempt, GatewayPaymentStatus } from "../payment-snapshot/gateways/types"
import { toPaise, transactionState, type PayuTransaction } from "./hash"

/** Pure mapping of PayU's records onto what the shared payment logic reads. */

export { PAYU_PROVIDER_ID }

/** What a PayU payment session keeps: one transaction id per attempt and what it asks for. */
export type PayuSessionData = {
  payu: {
    txnid: string
    amount_paise: number
    currency_code: string
    /** PayU's own id for the payment, once there is one. */
    mihpayid?: string | null
    state?: string
    /** Set only by the late-payment rebind: keep this transaction instead of opening a new one. */
    rebind?: boolean
  }
}

export function sessionPayu(session: { data?: Record<string, unknown> | null } | null | undefined): PayuSessionData["payu"] | null {
  const payu = (session?.data as Partial<PayuSessionData> | null | undefined)?.payu
  return payu && typeof payu.txnid === "string" && payu.txnid ? payu : null
}

const STATUS: Record<string, GatewayPaymentStatus> = {
  captured: "captured",
  authorized: "authorized",
  pending: "pending",
  failed: "failed",
}

/** A PayU transaction as a shared attempt. Null when PayU does not know it. */
export function payuAttempt(txnid: string, detail: PayuTransaction | null): GatewayAttempt | null {
  if (!detail) return null
  const state = transactionState(detail)
  if (state === "not_found") return null
  const requested = toPaise(detail.amt)
  const paid = toPaise(detail.transaction_amount ?? detail.amt)
  return {
    ref: txnid,
    amount_paise: requested,
    currency: "INR",
    payments: detail.mihpayid
      ? [{ id: String(detail.mihpayid), attempt_ref: detail.txnid ?? txnid, amount_paise: paid, currency: "INR", status: STATUS[state] }]
      : [],
    raw: detail,
  }
}
