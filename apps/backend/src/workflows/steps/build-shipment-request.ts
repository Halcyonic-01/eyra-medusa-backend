import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { ShipmentDetails } from "../../modules/order-dispatch/transitions"

export type ShipmentRequest = {
  medusaOrderId: string
  eyraOrderRef: string
  paymentMethod: "prepaid" | "cod"
  shipping: {
    fullName: string
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    pincode: string
    phone: string
    email: string
  }
  items: { name: string; sku: string; type: string; quantity: number; price: number }[]
  /** Prepaid: the full order value. COD: what the courier collects. */
  subtotal: number
}

export type ShipmentPlan =
  | { action: "ship"; request: ShipmentRequest }
  /** The courier already has this order (for example it shipped under the old flow). */
  | { action: "adopt"; shipment: ShipmentDetails }
  | { action: "stop"; reason: "order_not_found" | "order_canceled" | "incomplete_order"; detail: string }

type Money = number | string | { value?: string | number } | null | undefined

type OrderRecord = {
  id: string
  display_id: number
  email: string | null
  status: string
  canceled_at?: string | Date | null
  total?: Money
  metadata?: Record<string, unknown> | null
  items?: {
    title?: string | null
    product_title?: string | null
    variant_sku?: string | null
    product_type?: string | null
    unit_price?: Money
    quantity?: Money
    detail?: { quantity?: Money } | null
  }[]
  shipping_address?: {
    first_name?: string | null
    last_name?: string | null
    address_1?: string | null
    address_2?: string | null
    city?: string | null
    province?: string | null
    postal_code?: string | null
    phone?: string | null
  } | null
  credit_lines?: { amount?: Money }[]
  payment_collections?: { payments?: { provider_id?: string | null }[] }[]
}

function toNumber(value: Money): number {
  if (value !== null && typeof value === "object") {
    return Number(value.value)
  }
  return Number(value)
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** What Shiprocket knows the order as. */
export function shiprocketOrderRef(displayId: number): string {
  return `EYRA-${displayId}`
}

/**
 * Works out what to ask the courier for, from the order alone: nothing the
 * customer's browser sent is trusted. Also notices an order that was cancelled
 * in the meantime (it must not ship) or already has a shipment.
 */
export function planShipment(order: OrderRecord | undefined): ShipmentPlan {
  if (!order) {
    return { action: "stop", reason: "order_not_found", detail: "The order could not be read" }
  }

  if (order.status === "canceled" || order.canceled_at) {
    return { action: "stop", reason: "order_canceled", detail: "The order was cancelled" }
  }

  const metadata = order.metadata ?? {}
  const existingShipmentId = text(metadata.shiprocket_shipment_id)
  // Only a finished shipment is taken as it is: courier, label and a pickup that
  // was not refused. A half-made one goes back to the shipping route, which
  // finishes the missing steps without creating a second courier order.
  const finished =
    Boolean(text(metadata.awb_code)) &&
    Boolean(text(metadata.shipping_label_url)) &&
    metadata.pickup_scheduled !== false
  if (existingShipmentId && finished) {
    return {
      action: "adopt",
      shipment: {
        // Orders shipped by the old flow used a different reference, so it is not known.
        shiprocket_order_ref: null,
        shiprocket_order_id: text(metadata.shiprocket_order_id) || null,
        shiprocket_shipment_id: existingShipmentId,
        awb_code: text(metadata.awb_code) || null,
        courier_name: text(metadata.courier_name) || null,
        label_url: text(metadata.shipping_label_url) || null,
        pickup_scheduled:
          typeof metadata.pickup_scheduled === "boolean" ? metadata.pickup_scheduled : null,
        note: null,
      },
    }
  }

  const address = order.shipping_address
  const incomplete = (detail: string): ShipmentPlan => ({
    action: "stop",
    reason: "incomplete_order",
    detail,
  })

  if (!address || !text(address.address_1) || !text(address.city) || !text(address.province)) {
    return incomplete("The delivery address is incomplete")
  }
  if (!text(address.postal_code) || !text(address.phone) || !text(order.email)) {
    return incomplete("The pincode, phone number or email is missing")
  }

  const items = (order.items ?? []).map((item) => {
    const quantity = toNumber(item.detail?.quantity ?? item.quantity)
    return {
      name: text(item.product_title) || text(item.title) || "Jewellery",
      sku: text(item.variant_sku) || text(item.title) || "EYRA-ITEM",
      type: text(item.product_type) || "ring",
      quantity,
      price: toNumber(item.unit_price),
    }
  })
  if (items.length === 0 || items.some((i) => !Number.isFinite(i.quantity) || i.quantity < 1 || !Number.isFinite(i.price))) {
    return incomplete("The order items could not be read")
  }

  const total = toNumber(order.total)
  if (!Number.isFinite(total)) {
    // Never guess what a courier should collect.
    return incomplete("The order total could not be read")
  }

  const credit = (order.credit_lines ?? []).reduce((sum, line) => sum + (toNumber(line.amount) || 0), 0)
  const providers = (order.payment_collections ?? []).flatMap((collection) =>
    (collection.payments ?? []).map((payment) => payment.provider_id ?? "")
  )
  const paidOnline = providers.some((id) => id.includes("razorpay"))

  // Paid online, or fully covered by wallet credit, so there is nothing to collect.
  const paymentMethod: "prepaid" | "cod" = paidOnline || total <= 0 ? "prepaid" : "cod"

  return {
    action: "ship",
    request: {
      medusaOrderId: order.id,
      eyraOrderRef: shiprocketOrderRef(order.display_id),
      paymentMethod,
      shipping: {
        fullName: [text(address.first_name), text(address.last_name)].filter(Boolean).join(" "),
        addressLine1: text(address.address_1),
        ...(text(address.address_2) ? { addressLine2: text(address.address_2) } : {}),
        city: text(address.city),
        state: text(address.province),
        pincode: text(address.postal_code),
        phone: text(address.phone),
        email: text(order.email),
      },
      items,
      subtotal: paymentMethod === "cod" ? total : total + credit,
    },
  }
}

type Input = {
  /** Orders as read by the query step; only the first is used. */
  orders: unknown[]
}

export const buildShipmentRequestStep = createStep(
  "build-shipment-request",
  async (input: Input) => {
    return new StepResponse(planShipment(input.orders[0] as OrderRecord | undefined))
  }
)
