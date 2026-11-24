import type { PaymentRefundState, RefundGateway, RefundRequest, RefundResult } from "../order-dispatch/refund-gateway"
import { paymentActions, PayuUnavailableError, requestRefund, verifyPayment } from "./api"
import { formatAmount, refundToken, toPaise } from "./hash"

/**
 * Refunds to the customer's PayU payment, once per refund however often asked:
 * the PayU token is derived from the caller's own refund id, PayU refuses a
 * token twice, and PayU is searched for that token before anything is sent.
 * Never throws (see RefundGateway).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const LIVE = (status: string) => status !== "failure" && status !== "failed"

async function mihpayidFor(request: { payment_ref: string | null; attempt_ref: string | null }): Promise<string | null> {
  if (request.payment_ref) return request.payment_ref
  if (!request.attempt_ref) return null
  const detail = await verifyPayment(request.attempt_ref)
  return detail?.mihpayid ? String(detail.mihpayid) : null
}

/** The refund PayU already has for this token, or null. Throws when PayU cannot be asked. */
async function existingRefund(mihpayid: string, token: string): Promise<string | null> {
  const actions = await paymentActions(mihpayid)
  const match = actions.find((action) => action.action === "refund" && action.token === token && LIVE(action.status))
  return match ? match.request_id : null
}

async function refund(request: RefundRequest): Promise<RefundResult> {
  let mihpayid: string | null
  try {
    mihpayid = await mihpayidFor(request)
  } catch (error) {
    return { ok: false, error: `PayU could not be asked for the payment: ${(error as Error).message}`, may_have_moved_money: false }
  }
  if (!mihpayid) return { ok: false, error: "The PayU payment for this order could not be found", may_have_moved_money: false }

  const token = refundToken(request.cancellation_id)
  try {
    const before = await existingRefund(mihpayid, token)
    if (before) return { ok: true, refund_id: before, verified: true }
  } catch (error) {
    return { ok: false, error: `PayU could not be checked, so no refund was sent: ${(error as Error).message}`, may_have_moved_money: false }
  }

  let unclear = ""
  try {
    const answer = await requestRefund(mihpayid, token, formatAmount(Math.round(request.amount * 100)))
    if (answer.kind === "queued") return { ok: true, refund_id: answer.request_id, verified: true }
    if (!answer.duplicate_token) return { ok: false, error: answer.error, may_have_moved_money: false }
    // The token is taken: an earlier attempt of this very refund reached PayU.
    unclear = answer.error
  } catch (error) {
    if (!(error instanceof PayuUnavailableError)) throw error
    unclear = error.message
  }
  for (const wait of [1000, 2000, 4000]) {
    await sleep(wait)
    try {
      const after = await existingRefund(mihpayid, token)
      if (after) return { ok: true, refund_id: after, verified: true }
    } catch {
      // Still unknown; try again.
    }
  }
  return { ok: false, error: unclear, may_have_moved_money: true }
}

async function paymentRefundState(paymentRef: string | null, attemptRef: string | null): Promise<PaymentRefundState> {
  try {
    const detail = attemptRef ? await verifyPayment(attemptRef) : null
    const mihpayid = paymentRef ?? (detail?.mihpayid ? String(detail.mihpayid) : null)
    if (!mihpayid || !detail) return { status: "unknown" }
    const refunded = (await paymentActions(mihpayid))
      .filter((action) => action.action === "refund" && LIVE(action.status))
      .reduce((sum, action) => sum + action.amount_paise, 0)
    return { status: "known", amount: toPaise(detail.transaction_amount ?? detail.amt) / 100, refunded: refunded / 100 }
  } catch {
    return { status: "unknown" }
  }
}

export const payuRefunds: RefundGateway = { refund, paymentRefundState }
