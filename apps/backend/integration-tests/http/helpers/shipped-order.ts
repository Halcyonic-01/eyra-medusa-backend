import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { LaunchFixtures } from "./launch-fixtures"
import type { checkoutFlow } from "./checkout-flow"

let seq = 0

/**
 * A real order from the checkout flow, then marked shipped the way dispatch
 * does it: a dispatch row with a courier reference and a tax invoice number.
 * Nothing is sent to a courier.
 */
export async function shippedOrder(
  container: MedusaContainer,
  flow: ReturnType<typeof checkoutFlow>,
  fx: LaunchFixtures,
  options: {
    items?: { variantId: string; quantity?: number }[]
    code?: string
    mode?: "cod" | "prepaid"
    customer?: { id: string; email: string }
    province?: string
  } = {}
) {
  const who = options.customer ?? (await flow.customer())
  const cartId = await flow.cart(who.email, options.items ?? [{ variantId: fx.variantByPrice[2000] }])
  if (options.code) {
    const applied: any = await flow.applyCode(cartId, options.code)
    if (!applied.ok) throw new Error(`could not apply ${options.code}: ${applied.message}`)
  }
  await flow.reconcile(cartId)
  await flow.setMode(cartId, options.mode ?? "cod")
  const orderId = await flow.placeCod(cartId, who.email, options.province)

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderId } })
  const displayId = Number((data[0] as any).display_id)

  seq += 1
  const dispatch = container.resolve("orderDispatch") as any
  // With dispatch switched on, an event handler makes the row a moment after the order.
  let existing: any = null
  if (process.env.ORDER_DISPATCH_ENABLED === "true") {
    for (let i = 0; i < 40 && !existing; i++) {
      ;[existing] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })
      if (!existing) await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const fields = {
    state: "shipped",
    window_ends_at: new Date(),
    shipped_at: new Date(),
    shiprocket_order_ref: `EYRA-${displayId}`,
    shiprocket_order_id: `SR-${seq}`,
    shiprocket_shipment_id: `SHIP-${seq}`,
    awb_code: `AWB${seq}`,
    invoice_fy: "26-27",
    invoice_seq: seq,
    invoice_number: `EYRA/26-27/${String(seq).padStart(5, "0")}`,
    invoice_issued_at: new Date("2026-10-15T05:00:00Z"),
  }
  const row = existing
    ? await dispatch.updateOrderDispatches({ id: existing.id, ...fields })
    : await dispatch.createOrderDispatches({ order_id: orderId, ...fields })
  return { ...who, orderId, displayId, dispatchId: row.id as string, awb: `AWB${seq}`, invoiceNumber: row.invoice_number as string }
}
