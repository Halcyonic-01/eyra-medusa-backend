import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import { CHECKOUT_MARKER } from "../../modules/order-dispatch/order-integrity"
import { judgePaymentStanding, loadPaymentStanding, STANDING_ORDER_FIELDS } from "../../modules/order-dispatch/payment-standing"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"

export type GrantOverrideInput = { order_id: string; actor_id: string; reason: string }

/**
 * Allows an order with no checkout behind it (one made in Medusa admin) to be
 * shipped. Refused unless that is the only thing holding it: an order an
 * interrupted checkout left behind, a replacement, or an order with no payment
 * covering what is due can never be released this way.
 */
export const grantDispatchOverrideStep = createStep(
  "grant-dispatch-override",
  async (input: GrantOverrideInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "order", fields: ["id", "status", "metadata"], filters: { id: input.order_id } })
    const order = data[0] as { id: string; status: string; metadata?: Record<string, unknown> | null } | undefined
    if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found")
    if (order.status === "canceled") throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This order is cancelled")
    if (typeof order.metadata?.[CHECKOUT_MARKER] === "string") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This order was started by a checkout; it cannot be released by hand")
    }
    if (order.metadata?.replacement_for_order) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Replacement orders are released by their exchange request")
    }

    const standing = await loadPaymentStanding(container, input.order_id)
    if (standing.ok) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This order is not held; nothing to override")
    if (standing.reason !== "no_cart") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Only the missing checkout can be overridden; this order is held because: ${standing.reason}`)
    }

    // With the override in place, the payment must still cover what is due.
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const { data: full } = await query.graph({
      entity: "order",
      fields: STANDING_ORDER_FIELDS,
      filters: { id: input.order_id },
    })
    const row = full[0] as any
    const num = (v: unknown) => Number((v as { numeric?: unknown })?.numeric ?? v)
    const withOverride = judgePaymentStanding({
      id: row.id,
      total: num(row.total),
      metadata: row.metadata ?? null,
      has_cart: false,
      replacement_linked: false,
      override: true,
      payment_collections: (row.payment_collections ?? []).filter(Boolean).map((c: any) => ({
        status: c.status ?? null,
        amount: num(c.amount),
        payments: (c.payments ?? []).filter(Boolean).map((p: any) => ({ amount: num(p.amount), canceled_at: p.canceled_at ?? null, provider_id: p.provider_id ?? null })),
      })),
    })
    if (!withOverride.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Record the payment for this order first (Medusa admin, Payments), then allow dispatch")
    }

    let created
    try {
      created = await service.createDispatchOverrides({
        order_id: input.order_id,
        actor_id: input.actor_id,
        reason: input.reason,
        held_reason: standing.reason,
      })
    } catch (error) {
      throw new MedusaError(MedusaError.Types.CONFLICT, "Dispatch is already allowed for this order")
    }
    return new StepResponse(created, created.id)
  },
  async (id, { container }) => {
    if (!id) return
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    await service.deleteDispatchOverrides(id)
  }
)

/** Withdraws the override in force, recording who did it. The row stays, as the audit trail. */
export const revokeDispatchOverrideStep = createStep(
  "revoke-dispatch-override",
  async (input: { order_id: string; actor_id: string }, { container }) => {
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [active] = await service.listDispatchOverrides({ order_id: input.order_id, revoked_at: null }, { take: 1 })
    if (!active) throw new MedusaError(MedusaError.Types.NOT_FOUND, "No override is in force for this order")
    const updated = await service.updateDispatchOverrides({ id: active.id, revoked_at: new Date(), revoked_by: input.actor_id })
    return new StepResponse(updated)
  }
)
