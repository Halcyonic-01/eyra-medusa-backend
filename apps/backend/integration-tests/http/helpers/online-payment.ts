import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, generateEntityId } from "@medusajs/framework/utils"

let seq = 0

/**
 * Makes an order look as if part of it was paid online with Razorpay and
 * captured (or, with `captured: false`, paid but never recorded as captured): a Razorpay payment with a capture, on the order's payment
 * collection, and the Razorpay ids on the order. Nothing reaches Razorpay.
 */
export async function addCapturedRazorpayPayment(
  container: MedusaContainer,
  orderId: string,
  amount: number,
  options: { captured?: boolean } = {}
) {
  const captured = options.captured !== false
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const { data } = await query.graph({ entity: "order", fields: ["id", "payment_collections.id"], filters: { id: orderId } })
  const collectionId = (data[0] as any).payment_collections[0].id as string

  seq += 1
  const paymentId = generateEntityId(undefined, "pay")
  const raw = JSON.stringify({ value: String(amount), precision: 20 })
  await pg.raw(
    `INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, data, payment_collection_id, payment_session_id, captured_at, created_at, updated_at)
     VALUES (?, ?, ?::jsonb, 'inr', 'pp_razorpay_razorpay', ?::jsonb, ?, ?, ${captured ? "now()" : "NULL"}, now(), now())`,
    [paymentId, amount, raw, JSON.stringify({ razorpayOrder: { id: `order_RZP${seq}` } }), collectionId, `payses_fake_${seq}_${Date.now()}`]
  )
  if (captured) {
    await pg.raw(
      `INSERT INTO capture (id, amount, raw_amount, payment_id, created_at, updated_at) VALUES (?, ?, ?::jsonb, ?, now(), now())`,
      [generateEntityId(undefined, "capt"), amount, raw, paymentId]
    )
  }
  await container.resolve(Modules.ORDER).updateOrders(
    { id: orderId },
    { metadata: { razorpay_payment_id: `pay_RZP${seq}`, razorpay_order_id: `order_RZP${seq}` } }
  )
  return { paymentId, razorpayPaymentId: `pay_RZP${seq}` }
}
