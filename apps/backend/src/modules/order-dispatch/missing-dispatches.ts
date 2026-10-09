import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ORDER_DISPATCH_MODULE } from "./index"
import type OrderDispatchModuleService from "./service"

/** How far back to look for orders the dispatcher never heard about. */
const LOOKBACK_DAYS = 3
/** Leave the order-placed handler this long to create the record itself. */
const GRACE_MINUTES = 2
/** Orders recovered per run. */
const LIMIT = 20

export type MissingDispatch = { order_id: string; display_id: number; created_at: Date }

type OrderRow = {
  id: string
  display_id: number
  created_at: string | Date
  metadata?: Record<string, unknown> | null
}

/**
 * Orders placed since dispatch tracking began that have no dispatch record,
 * for example because the order-placed handler failed. Without a record an
 * order never ships, so the job recreates it. Orders shipped by the earlier
 * flow (they carry a Shiprocket shipment id) are left alone.
 */
export async function findOrdersMissingDispatch(
  container: MedusaContainer,
  now: Date = new Date()
): Promise<MissingDispatch[]> {
  const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  // The first record marks when tracking began; orders before it were shipped the old way.
  const [first] = await service.listOrderDispatches({}, { take: 1, order: { created_at: "ASC" }, withDeleted: true })
  if (!first) {
    return []
  }

  const lookback = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const trackedSince = new Date(first.created_at)
  const since = trackedSince > lookback ? trackedSince : lookback
  const until = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000)
  if (since >= until) {
    return []
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "created_at", "metadata"],
    filters: {
      created_at: { $gte: since, $lt: until },
      status: { $nin: ["canceled", "draft"] },
    },
  })
  const orders = (data as unknown as OrderRow[]).filter(
    (order) => typeof order.metadata?.shiprocket_shipment_id !== "string" || !order.metadata.shiprocket_shipment_id
  )
  if (orders.length === 0) {
    return []
  }

  const tracked = await service.listOrderDispatches(
    { order_id: orders.map((order) => order.id) },
    { take: orders.length }
  )
  const known = new Set(tracked.map((row) => row.order_id))

  return orders
    .filter((order) => !known.has(order.id))
    .slice(0, LIMIT)
    .map((order) => ({
      order_id: order.id,
      display_id: Number(order.display_id),
      created_at: new Date(order.created_at),
    }))
}

export type UncapturedPayment = { order_id: string; display_id: number }

type PaidOrderRow = {
  id: string
  display_id: number
  metadata?: Record<string, unknown> | null
  payment_collections?: { payments?: { provider_id?: string | null; captures?: { id: string }[] }[] }[]
}

/**
 * Prepaid orders whose Razorpay payment Medusa still has not recorded as
 * captured a while after the order. That happens when Razorpay's payment
 * webhook is not reaching Medusa; until it does, the customer cannot cancel
 * and staff cannot cancel the order in Medusa.
 */
export async function findUncapturedPrepaidOrders(
  container: MedusaContainer,
  now: Date = new Date()
): Promise<UncapturedPayment[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const until = new Date(now.getTime() - 15 * 60 * 1000)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "metadata",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captures.id",
    ],
    filters: { created_at: { $gte: since, $lt: until }, status: { $nin: ["canceled", "draft"] } },
  })
  return (data as unknown as PaidOrderRow[])
    .filter((order) => !order.metadata?.capture_alerted)
    .filter((order) => {
      const razorpay = (order.payment_collections ?? [])
        .flatMap((collection) => collection.payments ?? [])
        .filter((payment) => (payment.provider_id ?? "").includes("razorpay"))
      return razorpay.length > 0 && razorpay.some((payment) => (payment.captures ?? []).length === 0)
    })
    .slice(0, LIMIT)
    .map((order) => ({ order_id: order.id, display_id: Number(order.display_id) }))
}
