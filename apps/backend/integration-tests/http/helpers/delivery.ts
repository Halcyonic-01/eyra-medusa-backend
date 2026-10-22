import type { MedusaContainer } from "@medusajs/framework/types"

/** Marks a shipped order as delivered `daysAgo` days back, the way Shiprocket's DELIVERED update does. */
export async function markDelivered(container: MedusaContainer, dispatchId: string, daysAgo = 1) {
  const at = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
  await (container.resolve("orderDispatch") as any).updateOrderDispatches({
    id: dispatchId,
    shiprocket_status: "DELIVERED",
    shiprocket_status_at: at,
    delivery_attempted_at: at,
    delivered_at: at,
  })
  return at
}
