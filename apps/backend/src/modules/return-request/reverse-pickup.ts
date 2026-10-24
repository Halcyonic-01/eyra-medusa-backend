import { callStorefront } from "../../utils/storefront"

/**
 * Books the courier to collect a return or exchange item from the customer and
 * bring it to us. The storefront holds the Shiprocket login, so it makes the
 * call (POST /v1/external/orders/create/return); the backend only says what to
 * collect and from where. Nothing here throws: the answer says what happened.
 */

export type ReversePickupInput = {
  return_request_id: string
  order_ref: string
  /** The reference this return has at Shiprocket, for example EYRA-21-R1. */
  reverse_order_ref: string
  type: "return" | "exchange"
  reason: string
  pickup: {
    fullName: string
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    pincode: string
    phone: string
    email: string
  }
  items: { name: string; sku: string; quantity: number; price: number; packSize: number }[]
}

export type ReversePickupResult =
  | { ok: true; reverse_order_ref: string; shiprocket_order_id: string | null; shipment_id: string | null; awb_code: string | null }
  | { ok: false; error: string }

export async function bookReversePickup(input: ReversePickupInput): Promise<ReversePickupResult> {
  const reply = await callStorefront("/api/returns/reverse-pickup", input as unknown as Record<string, unknown>, { timeoutMs: 60000 })
  if (reply.kind !== "answered") return { ok: false, error: reply.message }
  const body = reply.body ?? {}
  if (reply.status !== 200 || body.success !== true) {
    return { ok: false, error: String(body.error ?? body.message ?? `The storefront answered ${reply.status}`).slice(0, 300) }
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : typeof value === "number" ? String(value) : null)
  return {
    ok: true,
    reverse_order_ref: input.reverse_order_ref,
    shiprocket_order_id: text(body.shiprocket_order_id),
    shipment_id: text(body.shipment_id),
    awb_code: text(body.awb_code),
  }
}
