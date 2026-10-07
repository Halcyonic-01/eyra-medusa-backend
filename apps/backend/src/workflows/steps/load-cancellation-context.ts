import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { loadCancellationContext } from "../../modules/order-dispatch/cancellation-context"

type Input = {
  order_id: string
}

/** Reads what a cancellation needs to know about the order. */
export const loadCancellationContextStep = createStep(
  "load-cancellation-context",
  async (input: Input, { container }) => {
    const context = await loadCancellationContext(container, input.order_id)
    if (!context) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order was not found", "order_not_found")
    }
    return new StepResponse(context)
  }
)
