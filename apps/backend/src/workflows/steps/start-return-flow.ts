import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RETURN_REQUEST_MODULE } from "../../modules/return-request"
import { exchangePaymentDue } from "../../modules/return-request/constants"
import { fromStoredItems } from "../../modules/return-request/items"
import { createExchangeFeeLink } from "../../modules/return-request/payment-link"
import { bookReversePickup } from "../../modules/return-request/reverse-pickup"
import type ReturnRequestModuleService from "../../modules/return-request/service"
import { toNumber } from "../../modules/wallet/utils"
import { postToStorefront } from "../../utils/storefront"
import { sendWhatsapp } from "../../utils/whatsapp"

type Address = {
  first_name?: string | null
  last_name?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  phone?: string | null
}

type OrderForPickup = { id: string; display_id: number; email: string | null; shipping_address?: Address | null }

export type StartedReturnFlow = {
  request_id: string
  /** What happened: a pickup was booked, a payment link was made, or our team has to take it from here. */
  outcome: "pickup_booked" | "pickup_failed" | "payment_link_created" | "manual_review"
}

const clean = (value: string | null | undefined) => (value ?? "").trim()

/**
 * What a request sets in motion once it is saved.
 *
 *  - A return with delivery confirmed books the courier at once. If the courier
 *    cannot be booked the request is kept for our team (status "pending", with
 *    the reason), and the team is told: the customer's request is never lost.
 *  - An exchange with delivery confirmed starts like a return: no fee, the courier
 *    is booked at once. Only when the replacement costs more is the difference
 *    asked for first, with a Razorpay payment link. Without the link there is
 *    nothing to wait for, so this fails and the request is not kept; the
 *    customer can simply try again.
 *  - A request whose delivery could not be confirmed waits for our team.
 */
export const startReturnFlowStep = createStep(
  "start-return-flow",
  async (input: { request_id: string }, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

    const [request] = await service.listReturnRequests({ id: input.request_id }, { take: 1 })
    if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
    if (!request.delivered_at) {
      return new StepResponse<StartedReturnFlow>({ request_id: request.id, outcome: "manual_review" })
    }

    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "email",
        "shipping_address.first_name",
        "shipping_address.last_name",
        "shipping_address.address_1",
        "shipping_address.address_2",
        "shipping_address.city",
        "shipping_address.province",
        "shipping_address.postal_code",
        "shipping_address.phone",
      ],
      filters: { id: request.order_id },
    })
    const order = data[0] as unknown as OrderForPickup | undefined
    if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
    const address = order.shipping_address ?? {}
    const fullName = [clean(address.first_name), clean(address.last_name)].filter(Boolean).join(" ")
    const orderRef = `EYRA-${order.display_id}`

    if (request.type === "exchange" && exchangePaymentDue(toNumber(request.amount_due))) {
      const origin = (() => {
        try {
          return new URL(process.env.STOREFRONT_REVALIDATE_URL ?? "").origin
        } catch {
          return undefined
        }
      })()
      const result = await createExchangeFeeLink({
        request_id: request.id,
        order_id: order.id,
        order_ref: orderRef,
        amount: toNumber(request.amount_due),
        customer: { name: fullName, email: order.email, phone: address.phone ?? null },
        callback_url: origin ? `${origin}/orders/${order.id}` : undefined,
      })
      if (!result.ok) {
        logger.error(`[exchange] could not make the payment link for ${request.id}: ${result.error}`)
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "We could not start your exchange just now. Please try again in a few minutes.",
          "payment_link_failed"
        )
      }
      await service.updateReturnRequests({
        id: request.id,
        status: "pending_fee",
        fee_link_id: result.link.id,
        fee_link_url: result.link.short_url,
      })
      await sendWhatsapp(logger, {
        template: "exchange_payment_link",
        phone: address.phone,
        name: fullName,
        params: { amount: toNumber(request.amount_due), link: result.link.short_url, order: orderRef },
      })
      return new StepResponse<StartedReturnFlow>({ request_id: request.id, outcome: "payment_link_created" })
    }

    const outcome = await bookPickupFor(container, request.id)
    return new StepResponse<StartedReturnFlow>({ request_id: request.id, outcome })
  }
)

/**
 * Books the reverse pickup for a request and records the result on it. Safe to
 * call again after a failure: a request that already has a pickup is left alone.
 */
export async function bookPickupFor(
  container: Parameters<Parameters<typeof createStep>[1]>[1]["container"],
  requestId: string
): Promise<"pickup_booked" | "pickup_failed"> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

  const [request] = await service.listReturnRequests({ id: requestId }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
  if (request.reverse_order_ref && request.reverse_shipment_id) return "pickup_booked"

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.address_1",
      "shipping_address.address_2",
      "shipping_address.city",
      "shipping_address.province",
      "shipping_address.postal_code",
      "shipping_address.phone",
    ],
    filters: { id: request.order_id },
  })
  const order = data[0] as unknown as OrderForPickup | undefined
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
  const address = order.shipping_address ?? {}

  const siblings = await service.listReturnRequests({ order_id: request.order_id })
  const reference = request.reverse_order_ref ?? `EYRA-${order.display_id}-R${siblings.length}`

  const booked = await bookReversePickup({
    return_request_id: request.id,
    order_ref: `EYRA-${order.display_id}`,
    reverse_order_ref: reference,
    type: request.type,
    reason: request.reason,
    pickup: {
      fullName: [clean(address.first_name), clean(address.last_name)].filter(Boolean).join(" "),
      addressLine1: clean(address.address_1),
      ...(clean(address.address_2) ? { addressLine2: clean(address.address_2) } : {}),
      city: clean(address.city),
      state: clean(address.province),
      pincode: clean(address.postal_code),
      phone: clean(address.phone),
      email: clean(order.email),
    },
    items: fromStoredItems(request.items).map((item) => ({
      name: item.title,
      sku: item.sku || item.title,
      quantity: item.quantity,
      price: item.unit_price,
      packSize: /\bpair\b/i.test(item.variant_title ?? "") ? 2 : 1,
    })),
  })

  if (!booked.ok) {
    logger.error(`[return] could not book the pickup for ${request.id}: ${booked.error}`)
    await service.updateReturnRequests({ id: request.id, status: "pending", reverse_error: booked.error })
    await postToStorefront(
      "/api/ops/notify",
      { type: "reverse_pickup_problem", order_id: request.order_id, return_request_id: request.id, error: booked.error },
      logger
    )
    return "pickup_failed"
  }

  await service.updateReturnRequests({
    id: request.id,
    status: "reverse_pickup_scheduled",
    reverse_order_ref: booked.reverse_order_ref,
    reverse_shipment_id: booked.shipment_id,
    reverse_awb: booked.awb_code,
    reverse_requested_at: new Date(),
    reverse_error: null,
  })
  return "pickup_booked"
}
