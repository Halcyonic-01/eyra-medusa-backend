/**
 * The price difference of an exchange (when the replacement costs more) is collected
 * with a Razorpay payment link. The request goes straight to Razorpay's REST API with
 * the keys the refund code already uses; RAZORPAY_API_BASE only exists so tests
 * can point it at a stand-in. Nothing here throws: the answer says what happened.
 */

const base = (): string => (process.env.RAZORPAY_API_BASE?.trim() || "https://api.razorpay.com/v1").replace(/\/+$/, "")

function authorization(): string | null {
  const keyId = process.env.RAZORPAY_TEST_KEY_ID ?? process.env.RAZORPAY_ID
  const keySecret = process.env.RAZORPAY_TEST_KEY_SECRET ?? process.env.RAZORPAY_SECRET
  if (!keyId || !keySecret) return null
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`
}

export type FeeLink = { id: string; short_url: string; amount_paise: number }
export type FeeLinkResult = { ok: true; link: FeeLink } | { ok: false; error: string }

export type FeeLinkInput = {
  request_id: string
  order_id: string
  order_ref: string
  /** Rupees to collect: the price difference. */
  amount: number
  customer: { name: string; email: string | null; phone: string | null }
  /** Where Razorpay sends the customer after paying. */
  callback_url?: string
  /** Links stop working after this many days. */
  valid_days?: number
}

export async function createExchangeFeeLink(input: FeeLinkInput): Promise<FeeLinkResult> {
  const auth = authorization()
  if (!auth) return { ok: false, error: "Razorpay keys are not set on the backend" }

  const paise = Math.round(input.amount * 100)
  if (!Number.isInteger(paise) || paise < 100) return { ok: false, error: "The amount to collect is too small" }

  const phone = (input.customer.phone ?? "").replace(/\D/g, "").slice(-10)
  const first = await sendLink(auth, input, paise, phone.length === 10 ? phone : null)
  // Razorpay refuses some phone numbers it thinks are fake (all the same digit, for
  // one). The phone is only for its SMS, so the link is made without it: the
  // customer still gets it by email, WhatsApp and on the order page.
  if (!first.ok && phone.length === 10 && /contact/i.test(first.error)) {
    return sendLink(auth, input, paise, null)
  }
  return first
}

async function sendLink(auth: string, input: FeeLinkInput, paise: number, phone: string | null): Promise<FeeLinkResult> {
  const expireBy = Math.floor(Date.now() / 1000) + (input.valid_days ?? 3) * 24 * 60 * 60

  try {
    const res = await fetch(`${base()}/payment_links`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: paise,
        currency: "INR",
        accept_partial: false,
        reference_id: input.request_id,
        description: `EYRA JEWELS exchange: price difference, order ${input.order_ref}`,
        customer: {
          name: input.customer.name || undefined,
          email: input.customer.email || undefined,
          contact: phone ? `+91${phone}` : undefined,
        },
        notify: { sms: Boolean(phone), email: Boolean(input.customer.email) },
        reminder_enable: true,
        notes: { return_request_id: input.request_id, order_id: input.order_id, purpose: "exchange_difference" },
        ...(input.callback_url ? { callback_url: input.callback_url, callback_method: "get" } : {}),
        expire_by: expireBy,
      }),
      signal: AbortSignal.timeout(20000),
    })
    const body = (await res.json().catch(() => null)) as { id?: string; short_url?: string; error?: { description?: string } } | null
    if (!res.ok || !body?.id || !body.short_url) {
      return { ok: false, error: body?.error?.description ?? `Razorpay answered ${res.status}` }
    }
    return { ok: true, link: { id: body.id, short_url: body.short_url, amount_paise: paise } }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** What Razorpay says about a link now. `paid_paise` is what has been paid on it so far. */
export type LinkState = {
  id: string
  status: "created" | "partially_paid" | "paid" | "expired" | "cancelled" | string
  amount_paise: number
  paid_paise: number
  /** The payment that paid it, when there is one. */
  payment_id: string | null
}
export type LinkStateResult = { ok: true; link: LinkState } | { ok: false; error: string }

/**
 * Reads a payment link from Razorpay, so a payment can be confirmed without
 * waiting for the webhook (which may be late, lost, or not set up at all).
 */
export async function fetchExchangeFeeLink(linkId: string): Promise<LinkStateResult> {
  const auth = authorization()
  if (!auth) return { ok: false, error: "Razorpay keys are not set on the backend" }
  try {
    const res = await fetch(`${base()}/payment_links/${encodeURIComponent(linkId)}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    })
    const body = (await res.json().catch(() => null)) as {
      id?: string
      status?: string
      amount?: number
      amount_paid?: number
      payments?: { payment_id?: string; status?: string }[] | null
      error?: { description?: string }
    } | null
    if (!res.ok || !body?.id || !body.status) {
      return { ok: false, error: body?.error?.description ?? `Razorpay answered ${res.status}` }
    }
    const captured = (body.payments ?? []).find((payment) => payment.status === "captured") ?? (body.payments ?? [])[0]
    return {
      ok: true,
      link: {
        id: body.id,
        status: body.status,
        amount_paise: Number(body.amount ?? 0),
        paid_paise: Number(body.amount_paid ?? 0),
        payment_id: captured?.payment_id ?? null,
      },
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * Cancels a link that is no longer wanted, so it cannot be paid. Razorpay
 * refuses this for a link that was already paid, and the answer says so.
 */
export async function cancelExchangeFeeLink(linkId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = authorization()
  if (!auth) return { ok: false, error: "Razorpay keys are not set on the backend" }
  try {
    const res = await fetch(`${base()}/payment_links/${encodeURIComponent(linkId)}/cancel`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return { ok: true }
    const body = (await res.json().catch(() => null)) as { error?: { description?: string } } | null
    return { ok: false, error: body?.error?.description ?? `Razorpay answered ${res.status}` }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
