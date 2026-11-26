import { RAZORPAY_PROVIDER_ID } from "../payment-snapshot/gateways/ids"

/**
 * How a refund to the customer's original payment method is made, one
 * implementation per payment provider (Razorpay here; others register theirs).
 * Behind a small interface so the cancellation logic can be exercised without
 * moving real money: REFUND_GATEWAY=fake (or fake_fail, fake_unverified,
 * fake_ambiguous) swaps in a stand-in for every provider, for tests only.
 *
 * The refund goes straight to Razorpay, tagged with the cancellation it belongs
 * to, rather than through Medusa's Razorpay plugin: the plugin reports success
 * without refunding when it cannot match the payment, and turns every failure
 * into the same error, so a timeout could not be told apart from a refusal.
 */

export type RefundRequest = {
  order_id: string
  /** The provider's payment id (Razorpay pay_...), when the order recorded it. */
  payment_ref: string | null
  /** The provider's attempt (Razorpay order_...), used to find the payment when its id was not recorded. */
  attempt_ref: string | null
  amount: number
  fee: number
  cancellation_id: string
  /** When the cancellation started; refunds of this amount since then count as this one. */
  since_ms: number
}

export type RefundResult =
  | { ok: true; refund_id: string | null; verified: boolean }
  | { ok: false; error: string; may_have_moved_money: boolean }

/**
 * Where a refund the provider accepted stands: paid out, still on its way,
 * failed at the provider (the money did not go back), or not known right now.
 */
export type RefundOutcome = "processed" | "pending" | "failed" | "unknown"

export type RefundLookup = { payment_ref: string | null; attempt_ref: string | null; refund_id: string }

export type PaymentRefundState =
  | { status: "known"; amount: number; refunded: number }
  | { status: "unknown" }

export interface RefundGateway {
  /** How much of the payment the provider has refunded, in rupees. Never throws. */
  paymentRefundState(paymentRef: string | null, attemptRef: string | null): Promise<PaymentRefundState>
  /**
   * Refunds once per cancellation, however often it is called: a refund that
   * already exists for the cancellation is returned instead of sending another.
   * Never throws. `may_have_moved_money` is false only when Razorpay clearly
   * refused or nothing was sent.
   */
  refund(request: RefundRequest): Promise<RefundResult>
  /** Where an accepted refund stands now. Never throws; "unknown" when the provider cannot be asked. */
  refundStatus(lookup: RefundLookup): Promise<RefundOutcome>
}

/** A provider's refund status, in the terms above. Anything not clearly paid out or failed is still on its way. */
export function refundOutcomeOf(status: string | null | undefined): RefundOutcome {
  const value = (status ?? "").toLowerCase()
  if (!value) return "unknown"
  if (["processed", "success", "successful", "completed", "refunded"].includes(value)) return "processed"
  if (["failed", "failure", "cancelled", "canceled", "rejected"].includes(value)) return "failed"
  return "pending"
}

const RAZORPAY_API = "https://api.razorpay.com/v1"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function razorpayAuth(): string | null {
  const keyId = process.env.RAZORPAY_TEST_KEY_ID ?? process.env.RAZORPAY_ID
  const keySecret = process.env.RAZORPAY_TEST_KEY_SECRET ?? process.env.RAZORPAY_SECRET
  if (!keyId || !keySecret) {
    return null
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`
}

const receiptFor = (cancellationId: string) => `cancel-${cancellationId}`.slice(0, 40)

type RazorpayRefund = {
  id: string
  amount: number
  created_at: number
  status: string
  receipt?: string | null
  notes?: Record<string, string> | unknown[] | null
}

type Lookup = { status: "found"; id: string } | { status: "not_found" } | { status: "unknown" }

/** A refund Razorpay already has for this cancellation, by its tag or, failing that, by amount and time. */
async function findRefund(auth: string, paymentId: string, request: RefundRequest): Promise<Lookup> {
  try {
    const res = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}/refunds?count=100`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { status: "unknown" }
    }
    const body = (await res.json()) as { items?: RazorpayRefund[] }
    const live = (body.items ?? []).filter((item) => item.status !== "failed")
    const paise = Math.round(request.amount * 100)
    const tagged = live.find((item) => {
      const notes = item.notes && !Array.isArray(item.notes) ? item.notes : {}
      return notes.cancellation_id === request.cancellation_id || item.receipt === receiptFor(request.cancellation_id)
    })
    // Untagged refunds come from staff in the Razorpay dashboard or from older code.
    const sameAmount = live.find((item) => item.amount === paise && item.created_at * 1000 >= request.since_ms - 10000)
    const match = tagged ?? sameAmount
    return match ? { status: "found", id: match.id } : { status: "not_found" }
  } catch {
    return { status: "unknown" }
  }
}

/** The captured payment on a Razorpay order, for orders that did not record the payment id. */
async function paymentForOrder(auth: string, razorpayOrderId: string | null): Promise<string | null> {
  if (!razorpayOrderId) {
    return null
  }
  try {
    const res = await fetch(`${RAZORPAY_API}/orders/${encodeURIComponent(razorpayOrderId)}/payments`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return null
    }
    const body = (await res.json()) as { items?: { id: string; status: string }[] }
    const items = body.items ?? []
    return (items.find((item) => item.status === "captured") ?? items.find((item) => item.status === "refunded"))?.id ?? null
  } catch {
    return null
  }
}

type Sent =
  | { kind: "created"; id: string }
  | { kind: "refused"; error: string }
  | { kind: "unclear"; error: string }

async function sendRefund(auth: string, paymentId: string, request: RefundRequest): Promise<Sent> {
  try {
    const res = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        // No X-Refund-Idempotency header: Razorpay accepts it only on accounts it has enabled it for,
        // and rejects the whole request otherwise ("invalid request sent"). A repeat is still safe:
        // the refund carries this cancellation's receipt and note, and findRefund looks for one
        // before sending and again after any failure.
      },
      body: JSON.stringify({
        amount: Math.round(request.amount * 100),
        speed: "normal",
        receipt: receiptFor(request.cancellation_id),
        notes: { order_id: request.order_id, cancellation_id: request.cancellation_id, fee_kept: String(request.fee) },
      }),
      signal: AbortSignal.timeout(20000),
    })
    const body = (await res.json().catch(() => null)) as {
      id?: string
      error?: { description?: string; code?: string; field?: string | null; reason?: string | null; source?: string | null }
    } | null
    if (res.ok && body?.id) {
      return { kind: "created", id: body.id }
    }
    // The description alone ("invalid request sent") does not say what was wrong, so keep the rest.
    const detail = [body?.error?.code, body?.error?.field && `field ${body.error.field}`, body?.error?.reason, body?.error?.source]
      .filter(Boolean)
      .join(", ")
    const error = `${body?.error?.description ?? `Razorpay answered ${res.status}`}${detail ? ` (${detail})` : ""} [HTTP ${res.status}]`
    // A 4xx is Razorpay saying no; a timeout or 5xx says nothing about the money.
    if (res.status >= 400 && res.status < 500 && res.status !== 408) {
      return { kind: "refused", error }
    }
    return { kind: "unclear", error }
  } catch (error) {
    return { kind: "unclear", error: (error as Error).message }
  }
}

async function paymentState(razorpayPaymentId: string | null, razorpayOrderId: string | null): Promise<PaymentRefundState> {
  const auth = razorpayAuth()
  if (!auth) {
    return { status: "unknown" }
  }
  const paymentId = razorpayPaymentId ?? (await paymentForOrder(auth, razorpayOrderId))
  if (!paymentId) {
    return { status: "unknown" }
  }
  try {
    const res = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { status: "unknown" }
    }
    const body = (await res.json()) as { amount?: number; amount_refunded?: number }
    if (typeof body.amount !== "number") {
      return { status: "unknown" }
    }
    return { status: "known", amount: body.amount / 100, refunded: (body.amount_refunded ?? 0) / 100 }
  } catch {
    return { status: "unknown" }
  }
}

async function refundAtRazorpay(request: RefundRequest): Promise<RefundResult> {
  const auth = razorpayAuth()
  if (!auth) {
    return { ok: false, error: "Razorpay keys are not set on the backend", may_have_moved_money: false }
  }
  const paymentId = request.payment_ref ?? (await paymentForOrder(auth, request.attempt_ref))
  if (!paymentId) {
    return { ok: false, error: "The Razorpay payment for this order could not be found", may_have_moved_money: false }
  }

  // A retry, or an earlier attempt that timed out, may already have refunded.
  const before = await findRefund(auth, paymentId, request)
  if (before.status === "found") {
    return { ok: true, refund_id: before.id, verified: true }
  }
  if (before.status === "unknown") {
    return { ok: false, error: "Razorpay could not be checked, so no refund was sent", may_have_moved_money: false }
  }

  const sent = await sendRefund(auth, paymentId, request)
  if (sent.kind === "created") {
    return { ok: true, refund_id: sent.id, verified: true }
  }

  // Give a slow request a moment to show up before deciding.
  for (const wait of sent.kind === "refused" ? [0] : [1000, 2000, 4000]) {
    await sleep(wait)
    const after = await findRefund(auth, paymentId, request)
    if (after.status === "found") {
      return { ok: true, refund_id: after.id, verified: true }
    }
  }
  return { ok: false, error: sent.error, may_have_moved_money: sent.kind === "unclear" }
}

async function razorpayRefundStatus(lookup: RefundLookup): Promise<RefundOutcome> {
  const auth = razorpayAuth()
  if (!auth) return "unknown"
  const paymentId = lookup.payment_ref ?? (await paymentForOrder(auth, lookup.attempt_ref))
  if (!paymentId) return "unknown"
  try {
    const res = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(lookup.refund_id)}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return "unknown"
    return refundOutcomeOf(((await res.json()) as { status?: string }).status)
  } catch {
    return "unknown"
  }
}

function fakeGateway(mode: string): RefundGateway {
  return {
    // Tests only: FAKE_REFUND_STATUS plays the provider's later verdict on a refund.
    refundStatus: async () => refundOutcomeOf(process.env.FAKE_REFUND_STATUS || "processed"),
    paymentRefundState: async () =>
      mode === "fake_unrefunded" ? { status: "known", amount: 1000, refunded: 0 } : { status: "known", amount: 1000, refunded: 1000 },
    refund: async (request) => {
      if (mode === "fake_fail") {
        return { ok: false, error: "Razorpay refused the refund", may_have_moved_money: false }
      }
      if (mode === "fake_ambiguous") {
        return { ok: false, error: "The request to Razorpay timed out", may_have_moved_money: true }
      }
      if (mode === "fake_unverified") {
        return { ok: true, refund_id: null, verified: false }
      }
      return { ok: true, refund_id: `rfnd_FAKE_${request.cancellation_id}`, verified: true }
    },
  }
}

const razorpayRefunds: RefundGateway = { refund: refundAtRazorpay, paymentRefundState: paymentState, refundStatus: razorpayRefundStatus }
const providers = new Map<string, RefundGateway>([[RAZORPAY_PROVIDER_ID, razorpayRefunds]])

/** Adds the refund implementation of another payment provider. */
export function registerRefundGateway(providerId: string, gateway: RefundGateway) {
  providers.set(providerId, gateway)
}

/** Answers without refunding, for a provider no implementation was registered for. */
function unsupported(providerId: string): RefundGateway {
  return {
    paymentRefundState: async () => ({ status: "unknown" }),
    refundStatus: async () => "unknown",
    refund: async () => ({ ok: false, error: `No refunds are set up for payment provider ${providerId}`, may_have_moved_money: false }),
  }
}

/** The refunds of a payment provider; Razorpay when none is given, which is every order before other providers. */
export function getRefundGateway(providerId: string = RAZORPAY_PROVIDER_ID): RefundGateway {
  const mode = (process.env.REFUND_GATEWAY ?? "").trim().toLowerCase()
  if (mode.startsWith("fake")) return fakeGateway(mode)
  return providers.get(providerId) ?? unsupported(providerId)
}
