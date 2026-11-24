import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { getRefundGateway } from "../order-dispatch/refund-gateway"
import { RAZORPAY_PROVIDER_ID } from "../payment-snapshot/gateways/ids"
import { toNumber } from "../wallet/utils"
import { postToStorefront } from "../../utils/storefront"
import { sendWhatsapp } from "../../utils/whatsapp"
import { bookPickupFor } from "../../workflows/steps/start-return-flow"
import { exchangePaymentDue } from "./constants"
import { RETURN_REQUEST_MODULE } from "./index"
import { cancelExchangeFeeLink, createExchangeFeeLink, fetchExchangeFeeLink } from "./payment-link"
import type ReturnRequestModuleService from "./service"

/**
 * The price difference of an exchange, from asking for it to the end.
 *
 * Razorpay can tell us about a payment three ways: its webhook, the customer
 * coming back from the payment page (we then ask Razorpay), and a job that asks
 * about links nobody has heard back on. All three end up in
 * `settleExchangePayment`, which holds the same lock as staff decisions on the
 * request, so a payment is acted on once, and never at the same moment as a
 * decline.
 *
 *  - paid in full while waiting: the payment is recorded and the courier booked;
 *  - paid after the exchange was closed (declined, or expired): refunded;
 *  - the link expired or was cancelled while waiting: the exchange is closed,
 *    which frees the item for a new request;
 *  - paid short: not accepted, and our team is told.
 */

type Container = MedusaContainer

const LOCK_TIMEOUT_SECONDS = 30
export const lockKeyFor = (requestId: string) => `return-request:${requestId}`

type Request = Awaited<ReturnType<ReturnRequestModuleService["listReturnRequests"]>>[number]

async function load(container: Container, requestId: string): Promise<Request> {
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  const [request] = await service.listReturnRequests({ id: requestId }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
  return request
}

const clean = (value: string | null | undefined) => (value ?? "").trim()

/* ── Asking for the payment ───────────────────────────────── */

/**
 * Makes the payment link for an exchange that owes a price difference, moves the
 * request to pending_fee, and sends the link to the customer. Returns false when
 * Razorpay could not make the link; the request is then left as it was.
 */
export async function requestExchangePayment(container: Container, requestId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  const request = await load(container, requestId)

  if (request.type !== "exchange" || !exchangePaymentDue(toNumber(request.amount_due))) {
    return { ok: false, error: "Nothing is owed on this request" }
  }
  if (request.fee_paid_at) return { ok: false, error: "The difference was already paid" }

  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "email", "shipping_address.first_name", "shipping_address.last_name", "shipping_address.phone"],
    filters: { id: request.order_id },
  })
  const order = data[0] as unknown as
    | { id: string; display_id: number; email: string | null; shipping_address?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null }
    | undefined
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found")
  const address = order.shipping_address ?? {}
  const fullName = [clean(address.first_name), clean(address.last_name)].filter(Boolean).join(" ")
  const orderRef = `EYRA-${order.display_id}`
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
    // Back to the order, where the payment is checked with Razorpay at once.
    callback_url: origin ? `${origin}/orders/${order.id}?exchange=${encodeURIComponent(request.id)}` : undefined,
  })
  if (!result.ok) {
    logger.error(`[exchange] could not make the payment link for ${request.id}: ${result.error}`)
    return { ok: false, error: result.error }
  }

  await service.updateReturnRequests({
    id: request.id,
    status: "pending_fee",
    fee_link_id: result.link.id,
    fee_link_url: result.link.short_url,
    reverse_error: null,
  })
  await sendWhatsapp(logger, {
    template: "exchange_payment_link",
    phone: address.phone,
    name: fullName,
    params: { amount: toNumber(request.amount_due), link: result.link.short_url, order: orderRef },
  })
  return { ok: true, url: result.link.short_url }
}

/* ── Hearing back ─────────────────────────────────────────── */

export type ObservedLink = {
  link_id: string
  /** Razorpay's link status: created, partially_paid, paid, expired or cancelled. */
  status: string
  paid_paise: number
  payment_id: string | null
}

export type SettleResult =
  | { acted: true; outcome: "pickup_booked" | "pickup_failed" | "refunded" | "refund_failed" | "closed_expired" }
  | { acted: false; reason: "unknown_link" | "already_processed" | "amount_short" | "waiting" }

/**
 * Acts on what Razorpay says about an exchange's link. Safe to call any number
 * of times, from anywhere: each payment is acted on once.
 */
export async function settleExchangePayment(container: Container, requestId: string, observed: ObservedLink): Promise<SettleResult> {
  return container.resolve(Modules.LOCKING).execute(
    lockKeyFor(requestId),
    () => settleLocked(container, requestId, observed),
    { timeout: LOCK_TIMEOUT_SECONDS }
  )
}

async function settleLocked(container: Container, requestId: string, observed: ObservedLink): Promise<SettleResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  const request = await load(container, requestId)
  if (request.type !== "exchange" || !request.fee_link_id || request.fee_link_id !== observed.link_id) {
    return { acted: false, reason: "unknown_link" }
  }

  const dueP = Math.round(toNumber(request.amount_due) * 100)

  if (observed.status === "paid") {
    if (observed.paid_paise < dueP) {
      logger.error(`[exchange] link ${observed.link_id} for ${request.id} was paid ${observed.paid_paise} paise, ${dueP} was asked`)
      await postToStorefront(
        "/api/ops/notify",
        { type: "exchange_payment_short", return_request_id: request.id, order_id: request.order_id, asked: dueP / 100, paid: observed.paid_paise / 100 },
        logger
      )
      return { acted: false, reason: "amount_short" }
    }

    if (request.status === "pending_fee") {
      await service.updateReturnRequests({ id: request.id, fee_paid_at: new Date(), fee_payment_id: observed.payment_id })
      const outcome = await bookPickupFor(container, request.id)
      return { acted: true, outcome }
    }

    // Paid after the exchange was closed: the money goes back.
    if (request.status === "rejected" && !request.fee_refunded_at) {
      if (!request.fee_paid_at || !request.fee_payment_id) {
        await service.updateReturnRequests({ id: request.id, fee_paid_at: new Date(), fee_payment_id: observed.payment_id })
      }
      const refunded = await refundExchangeDifference(container, request.id)
      return { acted: true, outcome: refunded ? "refunded" : "refund_failed" }
    }
    return { acted: false, reason: "already_processed" }
  }

  if ((observed.status === "expired" || observed.status === "cancelled") && request.status === "pending_fee") {
    await closeUnpaidExchange(
      container,
      request,
      observed.status === "expired"
        ? "The payment link expired before the difference was paid, so this exchange was closed. You can start a new exchange while your exchange window is open."
        : "The payment link was cancelled, so this exchange was closed. You can start a new exchange while your exchange window is open."
    )
    return { acted: true, outcome: "closed_expired" }
  }

  return request.status === "pending_fee" ? { acted: false, reason: "waiting" } : { acted: false, reason: "already_processed" }
}

/** Asks Razorpay about the request's link now, and acts on the answer. */
export async function syncExchangePayment(container: Container, requestId: string): Promise<SettleResult | { acted: false; reason: "no_link" | "unreachable" }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const request = await load(container, requestId)
  if (request.type !== "exchange" || !request.fee_link_id) return { acted: false, reason: "no_link" }
  const state = await fetchExchangeFeeLink(request.fee_link_id)
  if (!state.ok) {
    logger.warn(`[exchange] could not read link ${request.fee_link_id} for ${request.id}: ${state.error}`)
    return { acted: false, reason: "unreachable" }
  }
  return settleExchangePayment(container, request.id, {
    link_id: state.link.id,
    status: state.link.status,
    paid_paise: state.link.paid_paise,
    payment_id: state.link.payment_id,
  })
}

/** An exchange that waited for a payment that never came is closed, which frees the item. */
async function closeUnpaidExchange(container: Container, request: Request, note: string): Promise<void> {
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  await service.updateReturnRequests({ id: request.id, status: "rejected", resolution_note: note, resolved_by: "system", resolved_at: new Date() })
  await container.resolve(Modules.EVENT_BUS).emit({
    name: "return_request.rejected",
    data: { request_id: request.id, customer_id: request.customer_id, order_id: request.order_id, type: request.type, note },
  })
}

/* ── Closing an exchange ──────────────────────────────────── */

/**
 * Refunds a paid difference to the customer's original payment method, once.
 * Returns true when it is refunded (now or before). A refund that could not be
 * made is reported to our team, who can retry by declining again or refund by hand.
 */
export async function refundExchangeDifference(container: Container, requestId: string): Promise<boolean> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
  const request = await load(container, requestId)
  if (request.fee_refunded_at) return true
  if (!request.fee_paid_at) return true

  const amount = toNumber(request.amount_due)
  const result = await getRefundGateway(RAZORPAY_PROVIDER_ID).refund({
    order_id: request.order_id,
    // Exchange differences are paid by Razorpay payment link.
    payment_ref: request.fee_payment_id ?? null,
    attempt_ref: null,
    amount,
    fee: 0,
    cancellation_id: `exchange-${request.id}`,
    since_ms: new Date(request.fee_paid_at).getTime(),
  })
  if (!result.ok) {
    logger.error(`[exchange] could not refund the difference for ${request.id}: ${result.error}`)
    await postToStorefront(
      "/api/ops/notify",
      { type: "exchange_refund_failed", return_request_id: request.id, order_id: request.order_id, amount, error: result.error },
      logger
    )
    return false
  }
  await service.updateReturnRequests({ id: request.id, fee_refund_id: result.refund_id, fee_refunded_at: new Date() })
  return true
}

/**
 * When an exchange is declined: a link still waiting is cancelled so it cannot
 * be paid, and a difference already paid is refunded. Never throws: the decline
 * stands either way, and a payment that slips through is refunded when Razorpay
 * reports it. The caller holds the request's lock.
 */
export async function closeExchangePayment(container: Container, requestId: string): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const request = await load(container, requestId)
    if (request.type !== "exchange") return
    if (request.fee_paid_at) {
      await refundExchangeDifference(container, request.id)
      return
    }
    if (request.fee_link_id) {
      const cancelled = await cancelExchangeFeeLink(request.fee_link_id)
      if (!cancelled.ok) {
        // Most often it was paid a moment ago: ask Razorpay, and refund it if so.
        logger.warn(`[exchange] could not cancel link ${request.fee_link_id} for ${request.id}: ${cancelled.error}`)
        const state = await fetchExchangeFeeLink(request.fee_link_id)
        if (state.ok && state.link.status === "paid") {
          const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)
          await service.updateReturnRequests({ id: request.id, fee_paid_at: new Date(), fee_payment_id: state.link.payment_id })
          await refundExchangeDifference(container, request.id)
        }
      }
    }
  } catch (error) {
    logger.error(`[exchange] could not close the payment for ${requestId}: ${(error as Error).message}`)
  }
}
