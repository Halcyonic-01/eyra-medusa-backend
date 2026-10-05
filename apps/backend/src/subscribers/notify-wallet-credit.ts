import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { postToStorefront } from "../utils/storefront"

type WalletCreditAdded = {
  kind: "issued" | "refunded"
  customer_id: string
  amount: number
  balance: number
  expires_at: string | null
  reason: string
  order_id: string | null
  note: string | null
}

/**
 * Tells the customer when credit lands in their wallet, whether staff issued it
 * for a return or exchange or it came back after a cancelled order. The
 * storefront sends the actual email.
 */
export default async function notifyWalletCreditHandler({
  event: { data },
  container,
}: SubscriberArgs<WalletCreditAdded>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  try {
    const { data: customers } = await query.graph({
      entity: "customer",
      fields: ["id", "email", "first_name"],
      filters: { id: data.customer_id },
    })
    const customer = customers[0]
    if (!customer?.email) {
      return
    }

    await postToStorefront(
      "/api/wallet/notify",
      {
        type: "credit_added",
        kind: data.kind,
        email: customer.email,
        first_name: customer.first_name,
        amount: data.amount,
        balance: data.balance,
        expires_at: data.expires_at,
        reason: data.reason,
        order_id: data.order_id,
        note: data.note,
      },
      logger
    )
  } catch (error) {
    // An email is never worth failing credit for.
    logger.error(`[wallet] could not notify customer ${data.customer_id}: ${(error as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "wallet.credit_added",
}
