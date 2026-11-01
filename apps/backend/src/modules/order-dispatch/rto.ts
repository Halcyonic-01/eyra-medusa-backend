import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { CreditNoteError } from "../credit-note/document"
import { issueCreditNote } from "../credit-note/issue"
import { postToStorefront } from "../../utils/storefront"
import { REVERSE_LOGISTICS_FEE, STORE_CREDIT_VALIDITY_MONTHS } from "../../utils/tax-config"
import { issueWalletCreditWorkflow } from "../../workflows/issue-wallet-credit"
import { loadCancellationContext } from "./cancellation-context"
import { emailRtoRefund } from "./customer-emails"
import { getRefundGateway } from "./refund-gateway"

/**
 * An order whose delivery was refused, or failed, has come back to us. The
 * customer has paid for goods they never got:
 *
 *  - a credit note reverses the sale (the Cash on Delivery charge stays, since
 *    the courier did try to deliver), keeping back the ₹99 reverse logistics fee;
 *  - what was paid online comes back to the card or bank it came from, and
 *    anything paid with wallet credit comes back to the wallet.
 *
 * Every part is safe to repeat: the credit note is one per order, the Razorpay
 * refund is tagged and looked up before it is sent, and the wallet credit has a
 * reference. RTO_AUTO_REFUND=false keeps the credit note but leaves the money
 * for a person.
 */

export type RtoResult = {
  status: "refunded" | "nothing_to_refund" | "needs_attention"
  credit_note_number: string | null
  refund_online: number
  refund_wallet: number
  error: string | null
}

const rupees = (paise: number) => Math.round(paise) / 100

export async function processReturnedParcel(container: MedusaContainer, orderId: string): Promise<RtoResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const orders = container.resolve(Modules.ORDER)

  const { data } = await query.graph({ entity: "order", fields: ["id", "display_id", "metadata"], filters: { id: orderId } })
  const order = data[0] as unknown as { id: string; display_id: number; metadata?: Record<string, unknown> | null } | undefined
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Order ${orderId} was not found`)

  const earlier = order.metadata?.rto_refund as { status?: string } | undefined
  if (earlier?.status === "refunded" || earlier?.status === "nothing_to_refund") {
    return earlier as RtoResult
  }

  const finish = async (result: RtoResult, extra: Record<string, unknown> = {}): Promise<RtoResult> => {
    await orders.updateOrders({ id: orderId }, { metadata: { rto_refund: { ...result, ...extra, at: new Date().toISOString() } } })
    await postToStorefront(
      "/api/ops/notify",
      {
        type: "rto_received",
        order_id: orderId,
        order_ref: `EYRA-${order.display_id}`,
        credit_note_number: result.credit_note_number,
        refund_online: result.refund_online,
        refund_wallet: result.refund_wallet,
        status: result.status,
        error: result.error,
      },
      logger
    )
    return result
  }

  let noteNumber: string | null = null
  let noteId: string
  let net: number
  try {
    const { note } = await issueCreditNote(container, {
      order_id: orderId,
      kind: "rto",
      reason: "DELIVERY_REFUSED",
      source_key: `rto:${orderId}`,
      returned: "all",
      reverse_cod: false,
      deduction: REVERSE_LOGISTICS_FEE,
    })
    noteNumber = note.credit_note_number
    noteId = note.id
    net = Number(note.net_credit_paise) / 100
  } catch (error) {
    const message = error instanceof CreditNoteError ? error.message : (error as Error).message
    logger.error(`[rto] could not issue the credit note for ${orderId}: ${message}`)
    return finish({ status: "needs_attention", credit_note_number: null, refund_online: 0, refund_wallet: 0, error: `Credit note: ${message}` })
  }

  const context = await loadCancellationContext(container, orderId)
  const paidOnline = context?.paid_online ?? 0
  const walletUsed = context?.wallet_used ?? 0
  const refundable = Math.min(net, paidOnline + walletUsed)
  const toOnline = Math.min(refundable, paidOnline)
  const toWallet = Math.round((refundable - toOnline) * 100) / 100

  // The customer paid online but Medusa never recorded the capture (Razorpay's payment.captured notice
  // did not arrive). Nothing can be refunded automatically, and saying "nothing to refund" would
  // leave money owed with nobody told.
  if (paidOnline <= 0 && context?.has_unsettled_online && net > 0) {
    return finish({
      status: "needs_attention",
      credit_note_number: noteNumber,
      refund_online: Math.max(Math.round((net - walletUsed) * 100) / 100, 0),
      refund_wallet: 0,
      error:
        "An online payment is on this order but is not recorded as captured, so nothing was refunded. " +
        "Check the payment in Razorpay and refund it by hand",
    })
  }

  if (refundable <= 0) {
    return finish({ status: "nothing_to_refund", credit_note_number: noteNumber, refund_online: 0, refund_wallet: 0, error: null })
  }

  if (process.env.RTO_AUTO_REFUND?.trim().toLowerCase() === "false") {
    return finish({
      status: "needs_attention",
      credit_note_number: noteNumber,
      refund_online: toOnline,
      refund_wallet: toWallet,
      error: "Automatic refunds are switched off (RTO_AUTO_REFUND=false): refund this by hand",
    })
  }

  let refundId: string | null = null
  if (toOnline > 0) {
    if (!context || context.online_payments.length !== 1) {
      return finish({
        status: "needs_attention",
        credit_note_number: noteNumber,
        refund_online: toOnline,
        refund_wallet: toWallet,
        error: "The online payment could not be matched, so it must be refunded by hand",
      })
    }
    const refund = await getRefundGateway().refund({
      order_id: orderId,
      razorpay_payment_id: context.razorpay_payment_id,
      razorpay_order_id: context.razorpay_order_id,
      amount: toOnline,
      fee: REVERSE_LOGISTICS_FEE,
      cancellation_id: `rto-${noteId}`,
      since_ms: Date.now(),
    })
    if (!refund.ok) {
      return finish({
        status: "needs_attention",
        credit_note_number: noteNumber,
        refund_online: toOnline,
        refund_wallet: toWallet,
        error: refund.may_have_moved_money ? `Refund outcome unknown: ${refund.error}` : `Refund failed: ${refund.error}`,
      })
    }
    refundId = refund.refund_id
  }

  if (toWallet > 0 && context?.customer_id) {
    const { errors } = await issueWalletCreditWorkflow(container).run({
      input: {
        customer_id: context.customer_id,
        amount: toWallet,
        reason: "return",
        order_id: orderId,
        note: "Delivery refused, parcel returned to us",
        reference: `rto:${noteId}`,
        validity_months: STORE_CREDIT_VALIDITY_MONTHS,
      },
      throwOnError: false,
    })
    if (errors.length) {
      return finish({
        status: "needs_attention",
        credit_note_number: noteNumber,
        refund_online: toOnline,
        refund_wallet: toWallet,
        error: `Wallet credit failed: ${errors[0].error?.message ?? "unknown"}`,
      }, { razorpay_refund_id: refundId })
    }
  }

  const refunded = await finish(
    { status: "refunded", credit_note_number: noteNumber, refund_online: rupees(toOnline * 100), refund_wallet: toWallet, error: null },
    { razorpay_refund_id: refundId }
  )
  // The customer is told the online part is on its way. The wallet part has its own email.
  if (refunded.refund_online > 0) {
    await emailRtoRefund(container, orderId, { amount: refunded.refund_online, credit_note: noteNumber })
  }
  return refunded
}
