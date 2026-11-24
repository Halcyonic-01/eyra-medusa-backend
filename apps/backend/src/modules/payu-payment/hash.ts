import crypto from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"

/**
 * PayU's hashes and the shapes its hosted checkout uses, as documented at
 * docs.payu.in ("Generate Hash", "verify_payment", "cancel_refund_transaction").
 * Pure, so each formula is unit tested. Every hash is SHA-512, lowercase hex.
 */

const sha512 = (text: string) => crypto.createHash("sha512").update(text, "utf8").digest("hex")

export type Udfs = { udf1?: string; udf2?: string; udf3?: string; udf4?: string; udf5?: string }

export type PaymentRequest = Udfs & {
  key: string
  txnid: string
  amount: string
  productinfo: string
  firstname: string
  email: string
}

/** Request hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT). */
export function requestHash(request: PaymentRequest, salt: string): string {
  return sha512(
    [
      request.key,
      request.txnid,
      request.amount,
      request.productinfo,
      request.firstname,
      request.email,
      request.udf1 ?? "",
      request.udf2 ?? "",
      request.udf3 ?? "",
      request.udf4 ?? "",
      request.udf5 ?? "",
      "",
      "",
      "",
      "",
      "",
      salt,
    ].join("|")
  )
}

/** What PayU posts back (surl, furl, webhooks); only the fields the reverse hash covers are named. */
export type PayuResponse = Udfs & {
  key?: string
  txnid?: string
  amount?: string
  productinfo?: string
  firstname?: string
  email?: string
  status?: string
  hash?: string
  additional_charges?: string
  additionalCharges?: string
  mihpayid?: string
}

/**
 * Reverse hash: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key),
 * with "additional_charges|" in front when PayU added charges.
 */
export function responseHash(response: PayuResponse, salt: string): string {
  const fields = [
    salt,
    response.status ?? "",
    "",
    "",
    "",
    "",
    "",
    response.udf5 ?? "",
    response.udf4 ?? "",
    response.udf3 ?? "",
    response.udf2 ?? "",
    response.udf1 ?? "",
    response.email ?? "",
    response.firstname ?? "",
    response.productinfo ?? "",
    response.amount ?? "",
    response.txnid ?? "",
    response.key ?? "",
  ]
  const charges = response.additional_charges ?? response.additionalCharges
  return sha512((charges ? `${charges}|` : "") + fields.join("|"))
}

/** A PayU response is genuine when its hash matches and it is for our merchant key. Constant-time compare. */
export function responseHashValid(response: PayuResponse, key: string, salt: string): boolean {
  if (typeof response.hash !== "string" || !/^[0-9a-f]{128}$/i.test(response.hash) || response.key !== key) return false
  const expected = Buffer.from(responseHash(response, salt), "hex")
  const given = Buffer.from(response.hash.toLowerCase(), "hex")
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

/** Merchant API (postservice) hash: sha512(key|command|var1|SALT). */
export function commandHash(key: string, command: string, var1: string, salt: string): string {
  return sha512([key, command, var1, salt].join("|"))
}

/** Paise to the amount text PayU is sent and hashes: "2000.00". */
export function formatAmount(paise: number): string {
  if (!Number.isInteger(paise) || paise <= 0) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid PayU amount: ${paise} paise`)
  return (paise / 100).toFixed(2)
}

/** PayU amount text ("2000.00", "2000") to whole paise; NaN when unreadable. */
export function toPaise(amount: unknown): number {
  const value = Number(amount)
  return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN
}

/** One transaction id per attempt: letters and digits only, at most 25 characters (PayU's limit). */
export function newTxnId(random: () => string = () => crypto.randomBytes(9).toString("hex")): string {
  return `eyra${random()}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 25)
}

/** A refund token, unique per refund (PayU allows 23 characters), from the caller's own id for that refund. */
export function refundToken(refundKey: string): string {
  return `r${crypto.createHash("sha256").update(refundKey).digest("hex").slice(0, 22)}`
}

/** PayU's limits on the hosted checkout fields that come from the customer. */
export function clip(text: string | null | undefined, max: number): string {
  return (text ?? "").replace(/[|]/g, " ").trim().slice(0, max)
}

/** One transaction as verify_payment reports it. */
export type PayuTransaction = {
  mihpayid?: string
  txnid?: string
  status?: string
  unmappedstatus?: string
  amt?: string
  transaction_amount?: string
  additional_charges?: string
  error_Message?: string
}

/** Our own reading of a transaction: captured (money taken), authorized (held), pending, failed, or unknown to PayU. */
export type PayuState = "captured" | "authorized" | "pending" | "failed" | "not_found"

export function transactionState(detail: PayuTransaction | null | undefined): PayuState {
  if (!detail || !detail.status || detail.status === "Not Found" || detail.mihpayid === "Not Found") return "not_found"
  const status = detail.status.toLowerCase()
  const unmapped = (detail.unmappedstatus ?? "").toLowerCase()
  if (status === "success") return unmapped === "auth" ? "authorized" : "captured"
  if (status === "failure" || status === "failed") return "failed"
  if (status === "pending" || unmapped === "pending" || unmapped === "initiated" || unmapped === "in progress") return "pending"
  return "failed"
}
