import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import { missingReservations, type ReservationNeed } from "../../modules/order-dispatch/order-integrity"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"

export type ReservationRepair = {
  /** Reservations created now. */
  created: number
  /** Needs that no stock location could cover: the stock was sold meanwhile. */
  short: ReservationNeed[]
  skipped?: string
}

const num = (v: unknown) => Number((v as { numeric?: unknown })?.numeric ?? v)

async function planFor(container: MedusaContainer, orderId: string) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "sales_channel_id",
      "fulfillments.id",
      // Asked for by name, items.quantity comes back empty; the line's quantity is in its detail.
      "items.*",
      "items.detail.quantity",
      "items.variant.manage_inventory",
      "items.variant.inventory_items.inventory_item_id",
      "items.variant.inventory_items.required_quantity",
    ],
    filters: { id: orderId },
  })
  return data[0] as any
}

/**
 * Gives an order the stock reservations Medusa's completion should have made,
 * when a crash stopped it part-way. Only what is missing is reserved, per line
 * and inventory item (so a Pair anklet reserves two of the Single's stock),
 * preferring the sales channel's stock locations and never more than a location
 * has free. Orders that are cancelled, fulfilled or already handed to the
 * courier are left alone: their reservations are gone on purpose.
 */
export const repairOrderReservationsStep = createStep(
  "repair-order-reservations",
  async (input: { order_id: string }, { container }) => {
    const order = await planFor(container, input.order_id)
    if (!order) return new StepResponse<ReservationRepair>({ created: 0, short: [], skipped: "not_found" })
    if (order.status === "canceled") return new StepResponse<ReservationRepair>({ created: 0, short: [], skipped: "canceled" })
    if ((order.fulfillments ?? []).filter(Boolean).length) {
      return new StepResponse<ReservationRepair>({ created: 0, short: [], skipped: "fulfilled" })
    }
    const dispatch: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [row] = await dispatch.listOrderDispatches({ order_id: input.order_id }, { take: 1 })
    if (row && ["dispatching", "shipped", "cancelled", "cancelling"].includes(row.state)) {
      return new StepResponse<ReservationRepair>({ created: 0, short: [], skipped: `dispatch_${row.state}` })
    }

    const lines = (order.items ?? []).filter(Boolean).map((item: any) => ({
      id: item.id,
      quantity: num(item.quantity ?? item.detail?.quantity),
      manage_inventory: item.variant ? item.variant.manage_inventory !== false : false,
      inventory_items: (item.variant?.inventory_items ?? []).filter(Boolean).map((link: any) => ({
        inventory_item_id: link.inventory_item_id,
        required_quantity: num(link.required_quantity ?? 1),
      })),
    }))
    if (lines.some((line: { quantity: number }) => !Number.isFinite(line.quantity) || line.quantity <= 0)) {
      return new StepResponse<ReservationRepair>({ created: 0, short: [], skipped: "quantity_unknown" })
    }
    const inventory = container.resolve(Modules.INVENTORY)
    const itemIds = Array.from(new Set(lines.flatMap((l: { inventory_items: { inventory_item_id: string }[] }) => l.inventory_items.map((i) => i.inventory_item_id)))) as string[]
    if (!itemIds.length) return new StepResponse<ReservationRepair>({ created: 0, short: [] })

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: channels } = await query.graph({
      entity: "sales_channel",
      fields: ["stock_locations.id"],
      filters: { id: order.sales_channel_id },
    })
    const channelLocations = new Set(((channels[0] as any)?.stock_locations ?? []).filter(Boolean).map((l: any) => l.id as string))

    const created: { line_item_id: string; inventory_item_id: string; location_id: string; quantity: number }[] = []
    const short: ReservationNeed[] = []
    // Under the same per-item locks Medusa's checkout reserves with, so this and
    // a live checkout (or another repair) can never both take the last unit.
    // What is missing and what is free are read again once the locks are held.
    await container.resolve(Modules.LOCKING).execute(itemIds, async () => {
      const existing = await inventory.listReservationItems({ line_item_id: lines.map((l: { id: string }) => l.id) })
      const needs = missingReservations(
        lines,
        existing.map((r) => ({ line_item_id: r.line_item_id as string, inventory_item_id: r.inventory_item_id, quantity: num(r.quantity) }))
      )
      for (const need of needs) {
        const levels = await inventory.listInventoryLevels({ inventory_item_id: need.inventory_item_id })
        const free = (level: { stocked_quantity: unknown; reserved_quantity: unknown }) => num(level.stocked_quantity) - num(level.reserved_quantity)
        const level =
          levels.find((l) => channelLocations.has(l.location_id) && free(l) >= need.quantity) ??
          (channelLocations.size ? undefined : levels.find((l) => free(l) >= need.quantity))
        if (!level) {
          short.push(need)
          continue
        }
        const reservation = { ...need, location_id: level.location_id }
        try {
          // The inventory module checks free stock again and refuses an overdraw.
          await inventory.createReservationItems([
            { ...reservation, description: "Restored after an interrupted checkout", metadata: { restored_by: "recover-order-integrity" } },
          ])
          created.push(reservation)
        } catch (error) {
          short.push(need)
        }
      }
    }, { timeout: 30 })
    return new StepResponse<ReservationRepair>({ created: created.length, short })
  }
)
