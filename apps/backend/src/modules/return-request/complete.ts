import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { issueCreditNoteWorkflow } from "../../workflows/issue-credit-note"
import { issueWalletCreditWorkflow } from "../../workflows/issue-wallet-credit"
import { postToStorefront } from "../../utils/storefront"
import { STORE_CREDIT_VALIDITY_MONTHS } from "../../utils/tax-config"
import { sendWhatsapp } from "../../utils/whatsapp"
import { addMonths } from "../wallet/config"
import { roundMoney, toNumber } from "../wallet/utils"
import { RETURN_REQUEST_MODULE } from "./index"
import { fromStoredItems } from "./items"
import { createReplacementOrder } from "./replacement-order"
import type ReturnRequestModuleService from "./service"

export type CompletedReturn = {
  request_id: string
  status: "approved"
  credit_note_number: string | null
  /** Store credit issued, in rupees. */
  credit_amount: number
  replacement_order_id: string | null
}

type Shipping = { first_name?: string | null; phone?: string | null }

/**
 * The part of a return or exchange that follows the quality check: our team has
 * the item and it passed. Every step is safe to repeat, so a failure part of the
 * way is simply run again (by the job that watches for them) and picks up where
 * it stopped, never paying or numbering anything twice.
 *
 *  - Return: a credit note for the items (GST reversed), then store credit for
 *    their paid value less the ₹99 reverse fee, valid 12 months, then the
 *    customer is told by WhatsApp.
 *  - Exchange: a credit note for the old item, the replacement order sent out,
 *    and, when the replacement costs less, the difference as store credit.
 */
export async function completeReceivedReturn(container: MedusaContainer, requestId: string): Promise<CompletedReturn> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service: ReturnRequestModuleService = container.resolve(RETURN_REQUEST_MODULE)

  const [request] = await service.listReturnRequests({ id: requestId }, { take: 1 })
  if (!request) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Request was not found")
  if (request.status === "approved") {
    return {
      request_id: request.id,
      status: "approved",
      credit_note_number: null,
      credit_amount: toNumber(request.credit_amount),
      replacement_order_id: request.replacement_order_id ?? null,
    }
  }
  if (request.status === "rejected") throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "This request was declined")
  if (!request.received_at) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "The item has not been marked as received")

  const items = fromStoredItems(request.items).map((item) => ({ item_id: item.item_id, quantity: item.quantity }))
  const isExchange = request.type === "exchange"

  const { result: note } = await issueCreditNoteWorkflow(container).run({
    input: {
      order_id: request.order_id,
      kind: isExchange ? "exchange" : "return",
      reason: request.reason,
      source_key: `${isExchange ? "exchange" : "return"}:${request.id}`,
      return_request_id: request.id,
      returned: items,
      reverse_cod: false,
      deduction: isExchange ? 0 : toNumber(request.fee_amount),
    },
  })

  let replacementOrderId: string | null = request.replacement_order_id ?? null
  let creditAmount = 0

  if (isExchange) {
    const replacement = await createReplacementOrder(container, request.id)
    replacementOrderId = replacement.order_id
    const difference = toNumber(request.price_difference)
    if (difference < 0) creditAmount = roundMoney(-difference)
  } else {
    creditAmount = roundMoney(note.net_credit_paise / 100)
  }

  if (creditAmount > 0) {
    await issueWalletCreditWorkflow(container).run({
      input: {
        customer_id: request.customer_id,
        amount: creditAmount,
        reason: isExchange ? "exchange" : "return",
        order_id: request.order_id,
        note: isExchange
          ? `Exchange: the replacement cost less than the item returned (${note.credit_note_number})`
          : `Return received (${note.credit_note_number})`,
        reference: `${isExchange ? "exchange-diff" : "return"}:${request.id}`,
        validity_months: STORE_CREDIT_VALIDITY_MONTHS,
      },
    })
  }

  await service.updateReturnRequests({
    id: request.id,
    status: "approved",
    credit_amount: creditAmount > 0 ? creditAmount : null,
    credit_note_id: note.credit_note_id,
    resolved_at: new Date(),
    resolution_note: isExchange
      ? "Your item arrived and passed our check. Your replacement is on its way."
      : "Your item arrived and passed our check. Store credit has been added to your wallet.",
  })

  // Telling the customer never holds anything up, and fails quietly.
  try {
    const { data } = await query.graph({
      entity: "order",
      fields: ["display_id", "shipping_address.first_name", "shipping_address.phone"],
      filters: { id: request.order_id },
    })
    const order = data[0] as unknown as { display_id: number; shipping_address?: Shipping | null } | undefined
    const phone = order?.shipping_address?.phone
    const name = order?.shipping_address?.first_name ?? null
    if (creditAmount > 0) {
      await sendWhatsapp(logger, {
        template: "store_credit_issued",
        phone,
        name,
        params: {
          amount: creditAmount,
          valid_until: addMonths(new Date(), STORE_CREDIT_VALIDITY_MONTHS).toLocaleDateString("en-IN", {
            day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
          }),
          credit_note: note.credit_note_number,
          order: `EYRA-${order?.display_id ?? ""}`,
        },
      })
    }
    if (isExchange && replacementOrderId) {
      await sendWhatsapp(logger, {
        template: "replacement_dispatched",
        phone,
        name,
        params: { order: `EYRA-${order?.display_id ?? ""}`, title: request.replacement_title ?? "your replacement" },
      })
    }
  } catch (error) {
    logger.error(`[return] could not message the customer for ${request.id}: ${(error as Error).message}`)
  }

  await postToStorefront("/api/ops/notify", { type: "return_completed", order_id: request.order_id, return_request_id: request.id }, logger)
  return {
    request_id: request.id,
    status: "approved",
    credit_note_number: note.credit_note_number,
    credit_amount: creditAmount,
    replacement_order_id: replacementOrderId,
  }
}
