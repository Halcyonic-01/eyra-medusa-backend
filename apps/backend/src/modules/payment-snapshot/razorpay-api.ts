import type { RazorpayOrder, RazorpayPayment } from "./rules"

/**
 * Read-only Razorpay lookups for the paid-price check: the order and the
 * payments made against it, straight from Razorpay with the server's keys. The
 * browser never supplies any of this.
 */

const RAZORPAY_API = "https://api.razorpay.com/v1"

/** Razorpay could not be asked (no keys, timeout, 5xx). The answer is unknown, not "unpaid". */
export class RazorpayUnavailableError extends Error {}

function razorpayHeaders(): Record<string, string> {
  const keyId = process.env.RAZORPAY_TEST_KEY_ID ?? process.env.RAZORPAY_ID
  const keySecret = process.env.RAZORPAY_TEST_KEY_SECRET ?? process.env.RAZORPAY_SECRET
  if (!keyId || !keySecret) throw new RazorpayUnavailableError("Razorpay keys are not configured")
  const account = process.env.RAZORPAY_TEST_ACCOUNT ?? process.env.RAZORPAY_ACCOUNT
  return {
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    ...(account ? { "X-Razorpay-Account": account } : {}),
  }
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetch(`${RAZORPAY_API}${path}`, {
      headers: razorpayHeaders(),
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    if (error instanceof RazorpayUnavailableError) throw error
    throw new RazorpayUnavailableError(`Razorpay request failed: ${(error as Error).message}`)
  }
  if (res.status === 404) return { status: 404, body: null }
  if (!res.ok) throw new RazorpayUnavailableError(`Razorpay answered ${res.status}`)
  return { status: res.status, body: await res.json() }
}

/** The Razorpay order and its payments. A missing order comes back as null, an unreachable Razorpay throws. */
export async function fetchRazorpayOrderPayments(
  razorpayOrderId: string
): Promise<{ order: RazorpayOrder | null; payments: RazorpayPayment[] }> {
  const id = encodeURIComponent(razorpayOrderId)
  const order = await getJson(`/orders/${id}`)
  if (!order.body) return { order: null, payments: [] }
  const payments = await getJson(`/orders/${id}/payments`)
  const items = ((payments.body as { items?: RazorpayPayment[] } | null)?.items ?? []) as RazorpayPayment[]
  return { order: order.body as RazorpayOrder, payments: items }
}
