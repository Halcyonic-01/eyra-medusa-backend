import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { Pg } from "../../modules/order-dispatch/transitions"
import {
  claimConfirmationEmail,
  markConfirmationEmailSent,
  releaseConfirmationEmail,
  type EmailClaim,
} from "../../utils/order-confirmation"

export type ConfirmationEmailAction = "claim" | "sent" | "release"

/** Claim, mark sent, or release the order's confirmation email. Each is one conditional update. */
export const confirmationEmailStep = createStep(
  "confirmation-email",
  async (input: { order_id: string; action: ConfirmationEmailAction }, { container }) => {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
    if (input.action === "claim") return new StepResponse<EmailClaim>(await claimConfirmationEmail(pg, input.order_id))
    if (input.action === "sent") await markConfirmationEmailSent(pg, input.order_id)
    else await releaseConfirmationEmail(pg, input.order_id)
    return new StepResponse<EmailClaim>({ claimed: false, already_sent: input.action === "sent" })
  }
)
