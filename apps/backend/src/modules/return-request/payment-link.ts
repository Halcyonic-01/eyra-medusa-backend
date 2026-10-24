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
          contact: phone.length === 10 ? `+91${phone}` : undefined,
        },
        notify: { sms: phone.length === 10, email: Boolean(input.customer.email) },
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
