import type { MedusaContainer } from "@medusajs/framework/types"
import { sendOrderEmailOnce, type EmailOutcome } from "../../utils/customer-email"
import { bankRefundEta } from "./config"
import { ORDER_DISPATCH_MODULE } from "./index"
import type OrderDispatchModuleService from "./service"

/**
 * The emails that follow an order's journey. Each is safe to ask for again:
 * the order remembers which it has sent (see utils/customer-email.ts).
 */

/** The parcel has been handed to the courier. */
export async function emailOrderShipped(container: MedusaContainer, orderId: string): Promise<EmailOutcome> {
  let dispatch: { awb_code?: string | null; courier_name?: string | null } | undefined
  try {
    const dispatches: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
    ;[dispatch] = await dispatches.listOrderDispatches({ order_id: orderId }, { take: 1 })
  } catch {
    // The email still goes out without the tracking number.
  }
  return sendOrderEmailOnce(container, orderId, "shipped", () => ({
    type: "order_shipped",
    awb: dispatch?.awb_code ?? null,
    courier: dispatch?.courier_name ?? null,
  }))
}

/** The courier reports the parcel delivered. */
export function emailOrderDelivered(container: MedusaContainer, orderId: string): Promise<EmailOutcome> {
  return sendOrderEmailOnce(container, orderId, "delivered", () => ({ type: "order_delivered" }))
}

/**
 * Money is going back to the card or bank after a parcel came back to us. The
 * wallet part of an RTO refund already has its own email (credit added), and
 * cancellations are explained in the cancellation email, so this is only for
 * the online part.
 */
export function emailRtoRefund(
  container: MedusaContainer,
  orderId: string,
  refund: { amount: number; credit_note: string | null }
): Promise<EmailOutcome> {
  return sendOrderEmailOnce(container, orderId, "rto_refund", () =>
    refund.amount > 0
      ? {
          type: "refund_processed",
          refund_amount: refund.amount,
          reason: "your parcel was returned to us",
          credit_note: refund.credit_note,
          eta: bankRefundEta(),
        }
      : null
  )
}
