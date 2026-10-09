import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { CancellationContext } from "../../modules/order-dispatch/cancellation"
import { bankRefundEta } from "../../modules/order-dispatch/config"
import { creditValidityMonths } from "../../modules/wallet/config"
import { postToStorefront } from "../../utils/storefront"
import type { CancellationOutcome } from "./execute-cancellation"

type Input = {
  context: CancellationContext
  outcome: CancellationOutcome
  reason: string
  note?: string | null
}

/**
 * Tells the customer what was refunded and where, and tells the team to stop
 * work on the order. The emails are sent by the storefront; if it cannot be
 * reached nothing is lost, because the cancellation is already recorded.
 */
export const notifyCancellationStep = createStep(
  "notify-cancellation",
  async (input: Input, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const { context, outcome } = input

    if (context.email) {
      await postToStorefront(
        "/api/wallet/notify",
        {
          type: "order_cancelled",
          email: context.email,
          order_number: context.display_id,
          method: outcome.refund_method,
          paid_online: outcome.paid_online,
          wallet_used: outcome.wallet_used,
          fee: outcome.fee,
          refund_amount: outcome.refund_amount,
          refund_status: outcome.refund_status,
          eta: bankRefundEta(),
          wallet_expires_at: outcome.wallet_expires_at,
          valid_months: creditValidityMonths(),
        },
        logger
      )
    }

    await postToStorefront(
      "/api/ops/notify",
      {
        type: "order_cancelled",
        order_id: context.order_id,
        order_ref: `EYRA-${context.display_id}`,
        method: outcome.refund_method,
        paid_online: outcome.paid_online,
        refund_amount: outcome.refund_amount,
        fee: outcome.fee,
        wallet_used: outcome.wallet_used,
        reason: input.reason,
        note: input.note ?? null,
        refund_status: outcome.refund_status,
        status: outcome.status,
        refund_error: outcome.refund_error,
      },
      logger
    )

    return new StepResponse({ notified: true })
  }
)
