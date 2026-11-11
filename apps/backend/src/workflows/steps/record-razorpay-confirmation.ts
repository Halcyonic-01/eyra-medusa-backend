import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { Pg } from "../../modules/order-dispatch/transitions"
import { fetchRazorpayOrderPayments, RazorpayUnavailableError } from "../../modules/payment-snapshot/razorpay-api"
import { RAZORPAY_PROVIDER_ID, sessionRazorpayOrderId, type SessionLike } from "../../modules/payment-snapshot/rules"
import { recordRazorpayIds } from "../../utils/order-confirmation"

export type RecordRazorpayConfirmationInput = {
  cart_id: string
  razorpay_order_id: string
  razorpay_payment_id: string
}

/**
 * Writes the Razorpay order and payment ids onto the order a cart became, as
 * often as asked. The Razorpay order must be the one this cart's payment
 * session opened, and Razorpay must list the payment as paid against it, so
 * the ids can never point an order at someone else's payment.
 */
export const recordRazorpayConfirmationStep = createStep(
  "record-razorpay-confirmation",
  async (input: RecordRazorpayConfirmationInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: links } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: input.cart_id } })
    const orderId = (links[0] as { order_id?: string } | undefined)?.order_id
    if (!orderId) throw new MedusaError(MedusaError.Types.NOT_FOUND, "This cart has not become an order yet")

    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "payment_collection.payment_sessions.id", "payment_collection.payment_sessions.provider_id", "payment_collection.payment_sessions.data"],
      filters: { id: input.cart_id },
    })
    const sessions = (((carts[0] as any)?.payment_collection?.payment_sessions ?? []) as SessionLike[]).filter(Boolean)
    const matches = sessions.some(
      (session) => session.provider_id === RAZORPAY_PROVIDER_ID && sessionRazorpayOrderId(session) === input.razorpay_order_id
    )
    if (!matches) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "That Razorpay order does not belong to this cart")
    }

    let paid = false
    try {
      const { payments } = await fetchRazorpayOrderPayments(input.razorpay_order_id)
      paid = payments.some(
        (payment) =>
          payment.id === input.razorpay_payment_id &&
          payment.order_id === input.razorpay_order_id &&
          (payment.status === "captured" || payment.status === "authorized")
      )
    } catch (error) {
      if (error instanceof RazorpayUnavailableError) {
        throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Razorpay could not be reached; try again")
      }
      throw error
    }
    if (!paid) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Razorpay does not list that payment as paid for this order")

    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    const recorded = await recordRazorpayIds(pg, orderId, input.razorpay_order_id, input.razorpay_payment_id)
    if (!recorded) {
      throw new MedusaError(MedusaError.Types.CONFLICT, "Different Razorpay ids are already recorded on this order")
    }
    return new StepResponse({ order_id: orderId })
  }
)
