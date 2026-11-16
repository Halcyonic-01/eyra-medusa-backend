import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../modules/return-request"
import { refundExchangeDifference, syncExchangePayment } from "../modules/return-request/exchange-payment"
import type ReturnRequestModuleService from "../modules/return-request/service"

/**
 * Asks Razorpay about every exchange still waiting for its price difference,
 * in case the webhook never came: a payment moves the exchange on, and a link
 * that expired closes it, which frees the item for a new request. Links made in
 * the last few minutes are left to the webhook and the customer's return. A
 * declined exchange whose paid difference could not be refunded is tried again.
 */
export default async function syncExchangePaymentsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

  const waiting = await service.listReturnRequests({ status: "pending_fee" }, { take: 100, order: { updated_at: "ASC" } })
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const request of waiting.filter((row) => row.fee_link_id && new Date(row.updated_at).getTime() < cutoff)) {
    try {
      const result = await syncExchangePayment(container, request.id)
      if (result.acted) logger.info(`[exchange] ${request.id}: ${result.outcome} (found by the payment check)`)
    } catch (error) {
      logger.warn(`[exchange] could not check the payment for ${request.id}: ${(error as Error).message}`)
    }
  }

  // A declined exchange whose paid difference could not be refunded at the time is tried again.
  const declined = await service.listReturnRequests({ status: "rejected", type: "exchange", fee_refunded_at: null }, { take: 100 })
  for (const request of declined.filter((row) => row.fee_paid_at)) {
    try {
      if (await refundExchangeDifference(container, request.id)) logger.info(`[exchange] refunded the difference for ${request.id} on retry`)
    } catch (error) {
      logger.warn(`[exchange] could not refund the difference for ${request.id}: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "sync-exchange-payments",
  schedule: "*/15 * * * *",
}
