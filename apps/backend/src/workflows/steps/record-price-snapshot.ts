import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PAYMENT_SNAPSHOT_MODULE } from "../../modules/payment-snapshot"
import { loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { buildSnapshot, RAZORPAY_PROVIDER_ID } from "../../modules/payment-snapshot/rules"
import type PaymentSnapshotModuleService from "../../modules/payment-snapshot/service"
import { stalePriceMessage, type StalePriceLine } from "../../utils/stale-prices"

export type RecordPriceSnapshotInput = { cart_id: string; stale: StalePriceLine[] }

/**
 * Records what the cart costs for the Razorpay payment just opened. Refuses if
 * any line is not at today's price, or if the cart, the session and the
 * Razorpay order disagree on the amount. Removed again if the workflow fails.
 */
export const recordPriceSnapshotStep = createStep(
  "record-price-snapshot",
  async (input: RecordPriceSnapshotInput, { container }) => {
    if (input.stale.length) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, stalePriceMessage(input.stale))
    }
    const state = await loadCartPaymentState(container, input.cart_id)
    const session = state?.razorpaySessions.find((s) => s.status === "pending") ?? state?.razorpaySessions[0]
    if (!state || !session || session.provider_id !== RAZORPAY_PROVIDER_ID || !state.cart.payment_collection?.id) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "The Razorpay payment could not be opened.")
    }
    const built = buildSnapshot(state.cart, session, state.cart.payment_collection.id)
    if (!built.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `We could not start the payment: ${built.message}`)
    }
    const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
    const created = await service.createPaymentPriceSnapshots({ ...built.snapshot, lines: built.snapshot.lines as never })
    return new StepResponse(created, created.id)
  },
  async (id, { container }) => {
    if (!id) return
    const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
    await service.deletePaymentPriceSnapshots(id)
  }
)
