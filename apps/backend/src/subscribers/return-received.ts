import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { postToStorefront } from "../utils/storefront"
import { completeReceivedReturnWorkflow } from "../workflows/complete-received-return"

/**
 * order.return_received: our team has the item and it passed. Issues the credit
 * note and the store credit, or sends the replacement. A failure is logged and
 * the team told; the job that watches for received-but-unfinished requests runs
 * it again, and every step is safe to repeat.
 */
export default async function returnReceivedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ order_id?: string; return_request_id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  // The event is also Medusa's own for its built-in returns, which carry no request of ours.
  if (!data.return_request_id?.startsWith("retreq_")) return

  try {
    await completeReceivedReturnWorkflow(container).run({ input: { request_id: data.return_request_id } })
  } catch (error) {
    logger.error(`[return] could not finish ${data.return_request_id}: ${(error as Error).message}`)
    await postToStorefront(
      "/api/ops/notify",
      { type: "return_not_finished", order_id: data.order_id, return_request_id: data.return_request_id, error: (error as Error).message },
      logger
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.return_received",
}
