import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { verifyRefunds } from "../modules/payment-snapshot/refund-verification"

/** Every half hour: follow accepted refunds until the provider pays them out; send failed ones again or tell the team. */
export default async function verifyPaymentRefundsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { late, cancellations } = await verifyRefunds(container)
  if (late.failed || late.review || cancellations.failed || cancellations.review) {
    logger.warn(`[refund-verify] late refunds ${JSON.stringify(late)}; cancellation refunds ${JSON.stringify(cancellations)}`)
  }
}

export const config = {
  name: "verify-payment-refunds",
  schedule: "*/30 * * * *",
}
