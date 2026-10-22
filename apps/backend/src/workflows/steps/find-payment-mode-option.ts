import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { optionCodeFor, type PaymentMode } from "../../utils/commerce-rules"

export type FindPaymentModeOptionInput = { mode: PaymentMode }

/**
 * Finds the shipping option behind a payment mode: complimentary shipping for
 * prepaid orders, the Cash on Delivery charge for COD. They are found by their
 * type code, which the setup script gives them.
 */
export const findPaymentModeOptionStep = createStep(
  "find-payment-mode-option",
  async (input: FindPaymentModeOptionInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "shipping_option",
      fields: ["id", "type.code"],
    })

    const code = optionCodeFor(input.mode)
    const option = data.find((entry) => entry.type?.code === code)
    if (!option) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Shipping option '${code}' is missing. Run: npx medusa exec ./src/scripts/setup-launch-commerce.ts`
      )
    }
    return new StepResponse(option.id as string)
  }
)
