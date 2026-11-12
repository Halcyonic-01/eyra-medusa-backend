/**
 * Pure rules for repairing what an interrupted cart completion can leave
 * behind. Each is used by a recovery job and unit tested on its own.
 */

/**
 * Written onto every cart at checkout (payment mode, Razorpay session) and
 * copied by Medusa onto the order it becomes. An order that carries it but is
 * not linked to that cart was left by an interrupted completion. Orders made in
 * Medusa admin never carry it, so they are never treated as such leftovers.
 */
export const CHECKOUT_MARKER = "eyra_checkout_cart_id"

/** How old a leftover must be before it is voided, well past any completion still running. */
export const ORPHAN_GRACE_MINUTES = 15

export type OrphanFacts = {
  status: string
  created_at: Date
  metadata: Record<string, unknown> | null
  /** The order is linked to a cart. */
  has_cart: boolean
  /** Payments recorded against the order, cancelled ones excluded. */
  payments: number
  /** Wallet credit was deducted for this order. */
  wallet_redeemed: boolean
  fulfillments: number
  /** order_dispatch state, if any. */
  dispatch_state: string | null
  /** The marked cart is linked to an order: its id, or null. */
  marked_cart_order_id: string | null
}

export type OrphanVerdict = { void: true; cart_id: string } | { void: false; reason: string }

/** Whether an order is a checkout leftover that can be voided without touching any money or stock movement. */
export function orphanVerdict(
  order: OrphanFacts & { id: string },
  now: Date = new Date(),
  options: { cartLockHeld?: boolean } = {}
): OrphanVerdict {
  const cartId = order.metadata?.[CHECKOUT_MARKER]
  if (typeof cartId !== "string" || !cartId.startsWith("cart_")) return { void: false, reason: "not_from_checkout" }
  if (order.metadata?.replacement_for_order) return { void: false, reason: "replacement" }
  if (order.status === "canceled") return { void: false, reason: "already_canceled" }
  if (order.has_cart) return { void: false, reason: "linked_to_cart" }
  if (order.payments > 0) return { void: false, reason: "has_payment" }
  if (order.wallet_redeemed) return { void: false, reason: "wallet_redeemed" }
  if (order.fulfillments > 0) return { void: false, reason: "fulfilled" }
  if (order.dispatch_state && order.dispatch_state !== "placed" && order.dispatch_state !== "dispatch_failed") {
    return { void: false, reason: `dispatch_${order.dispatch_state}` }
  }
  if (order.marked_cart_order_id === order.id) return { void: false, reason: "linked_to_cart" }
  // The wait only protects a completion of the cart that may still be running;
  // a caller holding that cart's completion lock knows none is.
  if (!options.cartLockHeld && now.getTime() - order.created_at.getTime() < ORPHAN_GRACE_MINUTES * 60 * 1000) {
    return { void: false, reason: "too_recent" }
  }
  return { void: true, cart_id: cartId }
}

export type ReservationNeed = { line_item_id: string; inventory_item_id: string; quantity: number }

/**
 * What each line still needs reserved: quantity times the inventory item's
 * required quantity (a Pair anklet needs two of the Single's stock), less what
 * is already reserved for that line and item. Lines whose variant does not
 * track inventory need nothing.
 */
export function missingReservations(
  lines: {
    id: string
    quantity: number
    manage_inventory: boolean
    inventory_items: { inventory_item_id: string; required_quantity: number }[]
  }[],
  existing: { line_item_id: string; inventory_item_id: string; quantity: number }[]
): ReservationNeed[] {
  const reserved = new Map<string, number>()
  for (const row of existing) {
    const key = `${row.line_item_id}:${row.inventory_item_id}`
    reserved.set(key, (reserved.get(key) ?? 0) + Number(row.quantity))
  }
  const needs: ReservationNeed[] = []
  for (const line of lines) {
    if (!line.manage_inventory) continue
    for (const link of line.inventory_items) {
      const wanted = Number(line.quantity) * Number(link.required_quantity || 1)
      const have = reserved.get(`${line.id}:${link.inventory_item_id}`) ?? 0
      if (wanted > have) needs.push({ line_item_id: line.id, inventory_item_id: link.inventory_item_id, quantity: wanted - have })
    }
  }
  return needs
}

/** Confirmation email retries: after 10, 30, 60, 120 then 240 minutes, then the team is told. */
export const EMAIL_RETRY_MINUTES = [10, 30, 60, 120, 240]

export function nextEmailAttempt(attempts: number, now: Date = new Date()): Date | null {
  const wait = EMAIL_RETRY_MINUTES[attempts]
  return wait === undefined ? null : new Date(now.getTime() + wait * 60 * 1000)
}
