import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import { CHECKOUT_MARKER, orphanVerdict, type OrphanFacts, type OrphanVerdict } from "../../modules/order-dispatch/order-integrity"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"
import { markCancelled, type Pg } from "../../modules/order-dispatch/transitions"
import { revertCountedOrphanUses } from "../../modules/order-dispatch/promotion-recovery"
import { WALLET_MODULE } from "../../modules/wallet"
import { redemptionReference } from "../../modules/wallet/utils"

/** Everything the void rule looks at, read fresh. */
export async function loadOrphanFacts(container: MedusaContainer, orderId: string): Promise<(OrphanFacts & { id: string; line_ids: string[] }) | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "created_at",
      "metadata",
      "items.id",
      "fulfillments.id",
      "payment_collections.payments.id",
      "payment_collections.payments.canceled_at",
    ],
    filters: { id: orderId },
  })
  const order = data[0] as any
  if (!order) return null

  const { data: links } = await query.graph({ entity: "order_cart", fields: ["cart_id"], filters: { order_id: orderId } })
  const cartId = order.metadata?.[CHECKOUT_MARKER]
  let markedCartOrder: string | null = null
  if (typeof cartId === "string") {
    const { data: cartLinks } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
    markedCartOrder = (cartLinks[0] as { order_id?: string } | undefined)?.order_id ?? null
  }

  const wallet = container.resolve(WALLET_MODULE) as { listWalletTransactions: (f: Record<string, unknown>, c?: Record<string, unknown>) => Promise<unknown[]> }
  const redeemed = await wallet.listWalletTransactions({ reference: redemptionReference(orderId) }, { take: 1 })

  const dispatch: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  const [row] = await dispatch.listOrderDispatches({ order_id: orderId }, { take: 1 })

  return {
    id: order.id,
    status: order.status,
    created_at: new Date(order.created_at),
    metadata: order.metadata ?? null,
    has_cart: links.length > 0,
    payments: (order.payment_collections ?? [])
      .flatMap((c: any) => c?.payments ?? [])
      .filter((p: any) => p && !p.canceled_at).length,
    wallet_redeemed: redeemed.length > 0,
    fulfillments: (order.fulfillments ?? []).filter(Boolean).length,
    dispatch_state: row?.state ?? null,
    marked_cart_order_id: markedCartOrder,
    line_ids: (order.items ?? []).filter(Boolean).map((item: any) => item.id),
  }
}

/** Decides from fresh facts. Read only. */
export const checkOrphanStep = createStep("check-orphan", async (input: { order_id: string }, { container }) => {
  const facts = await loadOrphanFacts(container, input.order_id)
  const verdict: OrphanVerdict = facts ? orphanVerdict(facts) : { void: false, reason: "not_found" }
  return new StepResponse(verdict)
})

/**
 * Voids a leftover order from an interrupted checkout, if the facts, read again
 * here, still say it is one. It had no payment, no wallet deduction, no shipment
 * and no fulfilment, so nothing is refunded: a discount-code use it is proven to
 * have taken is given back (see promotion-recovery), any stock it held is
 * released, its dispatch record is closed, and the order is marked cancelled
 * with the reason. Medusa's order-cancelled event is deliberately not sent, so
 * none of the refund and wallet handlers that listen to it run.
 *
 * The caller must hold the completion lock of the order's cart.
 */
export async function performOrphanVoid(
  container: MedusaContainer,
  orderId: string,
  options: { cartLockHeld?: boolean } = {}
): Promise<{ voided: boolean; reason: string; cart_id?: string; codes_given_back?: string[] }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const facts = await loadOrphanFacts(container, orderId)
  const verdict = facts ? orphanVerdict(facts, new Date(), options) : ({ void: false, reason: "not_found" } as OrphanVerdict)
  if (!facts || !verdict.void) return { voided: false, reason: verdict.void ? "changed" : verdict.reason }

  const codes = await revertCountedOrphanUses(container, orderId)
  if (facts.line_ids.length) {
    await container.resolve(Modules.INVENTORY).deleteReservationItemsByLineItem(facts.line_ids)
  }
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  await markCancelled(pg, orderId, ["placed", "dispatch_failed"])
  await container.resolve(Modules.ORDER).updateOrders(
    { id: orderId },
    {
      status: "canceled",
      canceled_at: new Date(),
      metadata: {
        orphan_voided_at: new Date().toISOString(),
        orphan_void_reason: `Left by an interrupted checkout of ${verdict.cart_id}; no payment, wallet deduction or shipment existed`,
        orphan_codes_given_back: codes,
      },
    } as never
  )
  logger.warn(
    `[order-integrity] voided order ${orderId}, left by an interrupted checkout of ${verdict.cart_id}` +
      (codes.length ? `; gave back the use of ${codes.join(", ")}` : "")
  )
  return { voided: true, reason: "voided", cart_id: verdict.cart_id, codes_given_back: codes }
}

/** Orders a checkout of this cart started that never got linked to it. */
export async function leftoverOrdersOfCart(container: MedusaContainer, cartId: string): Promise<string[]> {
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  const { rows } = await pg.raw(
    `SELECT o.id FROM "order" o
      WHERE o.deleted_at IS NULL AND o.status <> 'canceled'
        AND o.created_at > now() - interval '7 days'
        AND o.metadata->>'${CHECKOUT_MARKER}' = ?
        AND NOT EXISTS (SELECT 1 FROM order_cart oc WHERE oc.order_id = o.id AND oc.deleted_at IS NULL)`,
    [cartId]
  )
  return rows.map((row) => String(row.id))
}

/** Job path: the workflow holds the cart lock around this step. */
export const voidOrphanOrderStep = createStep("void-orphan-order", async (input: { order_id: string }, { container }) => {
  return new StepResponse(await performOrphanVoid(container, input.order_id))
})

/**
 * Checkout path: before a cart is changed, priced or paid for again, clear any
 * leftover a crashed completion of this same cart left, so its discount-code
 * use is back before Medusa recomputes the cart's codes (it drops a code whose
 * use is spent). Takes the cart's completion lock itself; if a completion of
 * the cart is running, it skips (that completion clears them).
 */
export async function clearCartLeftovers(container: MedusaContainer, cartId: string): Promise<string[]> {
  const leftovers = await leftoverOrdersOfCart(container, cartId)
  if (!leftovers.length) return []
  const voided: string[] = []
  try {
    await container.resolve(Modules.LOCKING).execute(
      [cartId],
      async () => {
        for (const orderId of leftovers) {
          if ((await performOrphanVoid(container, orderId, { cartLockHeld: true })).voided) voided.push(orderId)
        }
      },
      { timeout: 5 }
    )
  } catch (error) {
    container.resolve(ContainerRegistrationKeys.LOGGER).warn(`[order-integrity] leftovers of ${cartId} not cleared now: ${(error as Error).message}`)
  }
  return voided
}

export const voidCartLeftoversStep = createStep("void-cart-leftovers", async (input: { cart_id: string }, { container }) => {
  return new StepResponse({ voided: await clearCartLeftovers(container, input.cart_id) })
})
