import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { issueCreditNoteWorkflow } from "../../workflows/issue-credit-note"
import { postToStorefront } from "../../utils/storefront"
import { ORDER_DISPATCH_MODULE } from "../order-dispatch"
import type OrderDispatchModuleService from "../order-dispatch/service"

/**
 * Staff cancelled an order whose tax invoice was already issued (it shipped), so
 * the invoice must be reversed with a credit note: every unit not yet credited,
 * and the Cash on Delivery charge as well when the courier never tried to
 * deliver. If delivery was attempted the charge stays: the service was done.
 *
 * One note per order (the source key), so a repeated cancel event cannot issue a
 * second. Failure never blocks the cancellation: the team is told and the note
 * can be issued again, since nothing was numbered.
 */
export async function issueCancellationCreditNote(container: MedusaContainer, orderId: string): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const dispatches: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  const [dispatch] = await dispatches.listOrderDispatches({ order_id: orderId }, { take: 1 })
  if (!dispatch?.invoice_number) return

  try {
    const { result } = await issueCreditNoteWorkflow(container).run({
      input: {
        order_id: orderId,
        kind: "cancellation",
        reason: "CANCELLED_AFTER_DISPATCH",
        source_key: `cancel:${orderId}`,
        returned: "all",
        reverse_cod: !dispatch.delivery_attempted_at,
        deduction: 0,
      },
    })
    if (result.status === "issued") {
      logger.info(`[credit-note] ${result.credit_note_number} issued for order ${orderId} cancelled after dispatch`)
    }
  } catch (error) {
    logger.error(`[credit-note] could not issue the credit note for cancelled order ${orderId}: ${(error as Error).message}`)
    await postToStorefront(
      "/api/ops/notify",
      { type: "credit_note_failed", order_id: orderId, error: (error as Error).message },
      logger
    )
  }
}
