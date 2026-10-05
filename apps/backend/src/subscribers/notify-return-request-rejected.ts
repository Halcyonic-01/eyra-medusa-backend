import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { postToStorefront } from "../utils/storefront"

type ReturnRequestRejected = {
  request_id: string
  customer_id: string
  order_id: string
  type: "return" | "exchange"
  note: string
}

/** Tells the customer their return or exchange request was declined, and why. */
export default async function notifyReturnRequestRejectedHandler({
  event: { data },
  container,
}: SubscriberArgs<ReturnRequestRejected>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  try {
    const { data: customers } = await query.graph({
      entity: "customer",
      fields: ["id", "email", "first_name"],
      filters: { id: data.customer_id },
    })
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "display_id"],
      filters: { id: data.order_id },
    })
    const customer = customers[0]
    if (!customer?.email) {
      return
    }

    await postToStorefront(
      "/api/wallet/notify",
      {
        type: "request_rejected",
        email: customer.email,
        first_name: customer.first_name,
        request_type: data.type,
        order_id: data.order_id,
        order_number: orders[0]?.display_id ?? null,
        note: data.note,
      },
      logger
    )
  } catch (error) {
    logger.error(
      `[return-request] could not notify customer ${data.customer_id}: ${(error as Error).message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "return_request.rejected",
}
