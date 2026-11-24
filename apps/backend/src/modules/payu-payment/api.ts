import { GatewayUnavailableError } from "../payment-snapshot/gateways/types"
import { requirePayuConfig, type PayuConfig } from "./config"
import { commandHash, type PayuTransaction } from "./hash"

/**
 * PayU merchant API (postservice): form-encoded POST of key, command, var1..,
 * hash = sha512(key|command|var1|SALT). Read with the server's own keys; the
 * browser never supplies any of it.
 */

/** PayU could not be asked (no keys, timeout, 5xx, unreadable answer). Unknown, not "unpaid". */
export class PayuUnavailableError extends GatewayUnavailableError {}

async function command(config: PayuConfig, name: string, vars: string[]): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ key: config.key, command: name, hash: commandHash(config.key, name, vars[0] ?? "", config.salt) })
  vars.forEach((value, index) => body.set(`var${index + 1}`, value))
  let res: Response
  try {
    res = await fetch(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw new PayuUnavailableError(`PayU request failed: ${(error as Error).message}`)
  }
  if (!res.ok) throw new PayuUnavailableError(`PayU answered ${res.status}`)
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    throw new PayuUnavailableError("PayU answered with something that is not JSON")
  }
}

function configOrUnavailable(): PayuConfig {
  try {
    return requirePayuConfig()
  } catch (error) {
    throw new PayuUnavailableError((error as Error).message)
  }
}

/** verify_payment for one transaction. Null when PayU does not know it (never submitted). */
export async function verifyPayment(txnid: string): Promise<PayuTransaction | null> {
  const body = await command(configOrUnavailable(), "verify_payment", [txnid])
  const details = (body.transaction_details ?? {}) as Record<string, PayuTransaction>
  const detail = details[txnid]
  if (!detail || detail.status === "Not Found" || detail.mihpayid === "Not Found") return null
  // status 0 with a real transaction would be a contradiction: treat as not answered.
  if (Number(body.status) !== 1) throw new PayuUnavailableError(`PayU verify_payment failed: ${String(body.msg ?? "")}`)
  return detail
}

export type PayuRefundAnswer =
  | { kind: "queued"; request_id: string | null }
  | { kind: "refused"; error: string; duplicate_token: boolean }

/** cancel_refund_transaction: var1 mihpayid, var2 our unique token, var3 amount. Throws PayuUnavailableError when the answer is unknown. */
export async function requestRefund(mihpayid: string, token: string, amount: string): Promise<PayuRefundAnswer> {
  const body = await command(configOrUnavailable(), "cancel_refund_transaction", [mihpayid, token, amount])
  const msg = String(body.msg ?? "")
  // PayU documents error_code 102 as success too.
  if (Number(body.status) === 1 || String(body.error_code ?? "") === "102") {
    return { kind: "queued", request_id: body.request_id != null ? String(body.request_id) : null }
  }
  return { kind: "refused", error: msg || "PayU refused the refund", duplicate_token: /token already used/i.test(msg) }
}

export type PayuAction = { request_id: string; action: string; token: string | null; amount_paise: number; status: string }

/** check_action_status by PayU id: the refunds and captures recorded against a payment. Empty when none. */
export async function paymentActions(mihpayid: string): Promise<PayuAction[]> {
  const body = await command(configOrUnavailable(), "check_action_status", [mihpayid, "payuid"])
  const details = (body.transaction_details ?? {}) as Record<string, unknown>
  const forPayment = details[mihpayid]
  if (Number(body.status) !== 1 || !forPayment || typeof forPayment !== "object") return []
  return Object.entries(forPayment as Record<string, Record<string, unknown>>).map(([requestId, action]) => ({
    request_id: String(action.request_id ?? requestId),
    action: String(action.action ?? "").toLowerCase(),
    token: action.token != null ? String(action.token) : null,
    amount_paise: Math.round(Number(action.amt ?? 0) * 100),
    status: String(action.status ?? "").toLowerCase(),
  }))
}
