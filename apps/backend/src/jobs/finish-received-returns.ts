import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RETURN_REQUEST_MODULE } from "../modules/return-request"
import type ReturnRequestModuleService from "../modules/return-request/service"
import { completeReceivedReturnWorkflow } from "../workflows/complete-received-return"

/**
 * Finishes returns and exchanges that were received but not completed: the
 * handler failed part of the way (a credit note that could not be issued, a
 * replacement that could not be created). Every step is safe to repeat, so this
 * just runs the same workflow again. Requests received in the last few minutes
 * are left to the handler.
 */
export default async function finishReceivedReturnsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

  const waiting = await service.listReturnRequests({ status: "awaiting_inspection" }, { take: 100 })
  const cutoff = Date.now() - 5 * 60 * 1000
  const stuck = waiting.filter((request) => request.received_at && new Date(request.received_at).getTime() < cutoff)

  for (const request of stuck) {
    try {
      await completeReceivedReturnWorkflow(container).run({ input: { request_id: request.id } })
      logger.info(`[return] finished ${request.id} on retry`)
    } catch (error) {
      logger.warn(`[return] ${request.id} is still not finished: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "finish-received-returns",
  schedule: "*/5 * * * *",
}
