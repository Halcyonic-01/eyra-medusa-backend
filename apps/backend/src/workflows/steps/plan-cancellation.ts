import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  BLOCK_MESSAGES,
  evaluateEligibility,
  planCancellation,
  type CancellationContext,
  type CancellationPlan,
  type RefundMethod,
} from "../../modules/order-dispatch/cancellation"
import { cancellationFee } from "../../modules/order-dispatch/config"
import { ORDER_DISPATCH_MODULE } from "../../modules/order-dispatch"
import type OrderDispatchModuleService from "../../modules/order-dispatch/service"

type Input = {
  context: CancellationContext
  customer_id: string
  refund_method?: RefundMethod
}

export type PlannedCancellation = {
  method: RefundMethod | "none"
  /** What goes to the chosen destination out of what was paid online. */
  refund_amount: number
  /** What the customer does not get back. */
  fee: number
  plan: CancellationPlan
}

/**
 * Decides whether the customer may cancel and exactly what they get back. It
 * refuses before anything is changed: wrong owner, shipment already created,
 * window closed, or a refund choice that does not apply.
 */
export const planCancellationStep = createStep(
  "plan-cancellation",
  async (input: Input, { container }) => {
    const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    const [dispatch] = await service.listOrderDispatches(
      { order_id: input.context.order_id },
      { take: 1 }
    )

    const eligibility = evaluateEligibility(input.context, input.customer_id, dispatch ?? null)
    if (!eligibility.can_cancel) {
      const type =
        eligibility.code === "not_your_order"
          ? MedusaError.Types.NOT_FOUND
          : MedusaError.Types.NOT_ALLOWED
      throw new MedusaError(type, BLOCK_MESSAGES[eligibility.code], eligibility.code)
    }

    const plan = planCancellation(input.context, cancellationFee())

    if (!plan.requires_choice) {
      const planned: PlannedCancellation = { method: "none", refund_amount: 0, fee: 0, plan }
      return new StepResponse(planned)
    }

    if (input.refund_method !== "wallet" && input.refund_method !== "original") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Choose where the refund should go: your wallet or the original payment method.",
        "refund_method_required"
      )
    }

    const option = input.refund_method === "wallet" ? plan.wallet : plan.original
    if (!option || !option.available) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        option?.unavailable_reason ?? "That refund option is not available for this order.",
        "refund_method_unavailable"
      )
    }
    if (input.refund_method === "original" && input.context.online_payments.length !== 1) {
      // Orders here are paid with one online payment; anything else needs a person.
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This order can't be refunded to the original payment method online. Please contact support.",
        "refund_method_unavailable"
      )
    }

    const planned: PlannedCancellation = {
      method: input.refund_method,
      refund_amount: option.amount,
      fee: option.fee,
      plan,
    }
    return new StepResponse(planned)
  }
)
