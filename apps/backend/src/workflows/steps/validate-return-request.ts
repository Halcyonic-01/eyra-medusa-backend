import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { fromStoredItems, type RequestedItem } from "../../modules/return-request/items"
import type ReturnRequestModuleService from "../../modules/return-request/service"
import { roundMoney, toNumber } from "../../modules/wallet/utils"

type OrderItem = {
  id: string
  title: string
  quantity?: unknown
  /** The quantity is only filled in on the line itself when this is requested too. */
  detail?: { quantity?: unknown } | null
  unit_price: unknown
}

type OrderRecord = {
  id: string
  customer_id?: string | null
  email?: string | null
  status?: string | null
  items?: OrderItem[] | null
}

type Input = {
  customer_id: string
  order_id: string
  items: { item_id: string; quantity: number }[]
  // Query results are loosely typed, so they are narrowed below.
  orders: unknown[]
  customers: { id: string; email?: string | null }[]
}

function sameEmail(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
}

/**
 * Checks a return or exchange request against the order it is about: the order
 * is the customer's, it was not cancelled, the items are on it, and the
 * quantities are not already covered by another open or approved request.
 * Returns the items as they will be stored.
 */
export const validateReturnRequestStep = createStep(
  "validate-return-request",
  async (input: Input, { container }) => {
    const customer = input.customers[0]
    if (!customer) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Customer was not found")
    }

    const order = input.orders[0] as OrderRecord | undefined
    if (!order) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
    }
    if (order.customer_id !== customer.id && !sameEmail(order.email, customer.email)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "That order does not belong to this customer")
    }
    if (order.status === "canceled") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "A cancelled order cannot be returned")
    }
    if (input.items.length === 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose at least one item")
    }

    const requestService: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
    const existing = await requestService.listReturnRequests({
      order_id: order.id,
      status: ["pending", "approved"],
    })
    const alreadyRequested = new Map<string, number>()
    for (const request of existing) {
      for (const item of fromStoredItems(request.items)) {
        alreadyRequested.set(item.item_id, (alreadyRequested.get(item.item_id) ?? 0) + item.quantity)
      }
    }

    const stored: RequestedItem[] = []
    const seen = new Set<string>()
    for (const wanted of input.items) {
      if (seen.has(wanted.item_id)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Each item can only be listed once")
      }
      seen.add(wanted.item_id)

      const line = (order.items ?? []).find((item) => item.id === wanted.item_id)
      if (!line) {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, `Item ${wanted.item_id} is not on this order`)
      }

      const ordered = toNumber(line.detail?.quantity ?? line.quantity)
      const open = ordered - (alreadyRequested.get(line.id) ?? 0)
      if (!Number.isInteger(wanted.quantity) || wanted.quantity < 1 || wanted.quantity > open) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          open <= 0
            ? `"${line.title}" already has a return or exchange request`
            : `You can request at most ${open} of "${line.title}"`
        )
      }

      const unitPrice = toNumber(line.unit_price)
      stored.push({
        item_id: line.id,
        title: line.title,
        quantity: wanted.quantity,
        unit_price: unitPrice,
        total: roundMoney(unitPrice * wanted.quantity),
      })
    }

    return new StepResponse(stored)
  }
)
