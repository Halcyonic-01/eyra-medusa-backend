import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PAYMENT_SNAPSHOT_MODULE } from "../../modules/payment-snapshot"
import { loadCartPaymentState } from "../../modules/payment-snapshot/check"
import { sessionAttempt } from "../../modules/payment-snapshot/gateways"
import { buildSnapshot } from "../../modules/payment-snapshot/rules"
import type PaymentSnapshotModuleService from "../../modules/payment-snapshot/service"
import { stalePriceMessage, type StalePriceLine } from "../../utils/stale-prices"

export type RecordPriceSnapshotInput = { cart_id: string; stale: StalePriceLine[] }

/**
 * Records what the cart costs for the online payment attempt just opened.
 * Refuses if any line is not at today's price, or if the cart, the session and
 * the provider's attempt disagree on the amount. Removed again if the workflow fails.
 */
export const recordPriceSnapshotStep = createStep(
  "record-price-snapshot",
  async (input: RecordPriceSnapshotInput, { container }) => {
    if (input.stale.length) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, stalePriceMessage(input.stale))
    }
    const state = await loadCartPaymentState(container, input.cart_id)
    const session = state?.prepaidSessions.find((s) => s.status === "pending") ?? state?.prepaidSessions[0]
    const { gateway, ref } = sessionAttempt(session)
    if (!state || !session || !gateway || !state.cart.payment_collection?.id) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "The online payment could not be opened.")
    }
    const built = buildSnapshot(state.cart, session, state.cart.payment_collection.id, {
      ref,
      attempt_amount_paise: gateway.sessionAttemptAmount(session),
    })
    if (!built.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `We could not start the payment: ${built.message}`)
    }
    const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
    // Earlier attempts stay on record (they can still be paid late) and are checked first by the late-payment sweep.
    await service.updatePaymentPriceSnapshots({
      selector: { cart_id: input.cart_id, superseded_at: null },
      data: { superseded_at: new Date(), late_checked_at: null },
    })
    const created = await service.createPaymentPriceSnapshots({ ...built.snapshot, lines: built.snapshot.lines as never })
    return new StepResponse(created, created.id)
  },
  async (id, { container }) => {
    if (!id) return
    const service: PaymentSnapshotModuleService = container.resolve(PAYMENT_SNAPSHOT_MODULE)
    await service.deletePaymentPriceSnapshots(id)
  }
)
