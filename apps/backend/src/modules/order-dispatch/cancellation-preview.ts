import type { MedusaContainer } from "@medusajs/framework/types"
import { ORDER_DISPATCH_MODULE } from "./index"
import {
  BLOCK_MESSAGES,
  evaluateEligibility,
  paymentKind,
  planCancellation,
  type BlockCode,
  type PaymentKind,
} from "./cancellation"
import { loadCancellationContext } from "./cancellation-context"
import { bankRefundEta, cancellationFee } from "./config"
import type OrderDispatchModuleService from "./service"
import { creditValidityMonths } from "../wallet/config"
import { WALLET_MODULE } from "../wallet"
import type WalletModuleService from "../wallet/service"
import { toNumber } from "../wallet/utils"

export type CancellationSummary = {
  requested_by: "customer" | "staff"
  reason: string | null
  refund_method: "wallet" | "original" | "none"
  paid_online: number
  wallet_used: number
  fee: number
  refund_amount: number
  status: "processing" | "completed" | "needs_attention"
  refund_status: "not_needed" | "pending" | "initiated" | "credited" | "failed" | "unverified"
  refund_error: string | null
  razorpay_refund_id: string | null
  wallet_expires_at: string | null
  created_at: string
  completed_at: string | null
}

export type CancellationPreview = {
  order_id: string
  display_id: number
  can_cancel: boolean
  code: BlockCode | null
  message: string | null
  dispatch_state: string | null
  /** When the cancel window closes, while it is open. */
  window_ends_at: string | null
  payment_kind: PaymentKind
  total: number
  paid_online: number
  wallet_used: number
  /** The fee for refunding to the original payment method. */
  fee: number
  requires_choice: boolean
  options: {
    wallet: { amount: number; available: boolean } | null
    original: { amount: number; fee: number; available: boolean; unavailable_reason?: string } | null
  }
  eta: string
  wallet_valid_months: number
  /** What happened, once the order has been cancelled. */
  cancellation: CancellationSummary | null
}

/** The stored cancellation record as the API and the storefront see it. */
export async function loadCancellationSummary(
  container: MedusaContainer,
  orderId: string
): Promise<CancellationSummary | null> {
  const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  const [record] = await service.listOrderCancellations({ order_id: orderId }, { take: 1 })
  if (!record) {
    return null
  }

  let walletExpiresAt: string | null = null
  if (record.wallet_transaction_id) {
    const walletService: WalletModuleService = container.resolve(WALLET_MODULE)
    const [transaction] = await walletService.listWalletTransactions(
      { id: record.wallet_transaction_id },
      { take: 1 }
    )
    walletExpiresAt = transaction?.expires_at ? new Date(transaction.expires_at).toISOString() : null
  }

  return {
    requested_by: record.requested_by,
    reason: record.reason ?? null,
    refund_method: record.refund_method,
    paid_online: toNumber(record.paid_online),
    wallet_used: toNumber(record.wallet_used),
    fee: toNumber(record.fee),
    refund_amount: toNumber(record.refund_amount),
    status: record.status,
    refund_status: record.refund_status,
    refund_error: record.refund_error ?? null,
    razorpay_refund_id: record.razorpay_refund_id ?? null,
    wallet_expires_at: walletExpiresAt,
    created_at: new Date(record.created_at).toISOString(),
    completed_at: record.completed_at ? new Date(record.completed_at).toISOString() : null,
  }
}

/**
 * What the customer sees before cancelling: whether they can, until when, and
 * exactly what each refund choice would give back. Returns null when the order
 * does not exist or is not theirs, so nothing is revealed about it.
 */
export async function buildCancellationPreview(
  container: MedusaContainer,
  orderId: string,
  customerId: string
): Promise<CancellationPreview | null> {
  const context = await loadCancellationContext(container, orderId)
  if (!context || context.customer_id !== customerId) {
    return null
  }

  const service: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  const [dispatch] = await service.listOrderDispatches({ order_id: orderId }, { take: 1 })

  const eligibility = evaluateEligibility(context, customerId, dispatch ?? null)
  const plan = planCancellation(context, cancellationFee())
  const cancellation = await loadCancellationSummary(container, orderId)

  const code = eligibility.can_cancel ? null : eligibility.code
  return {
    order_id: orderId,
    display_id: context.display_id,
    can_cancel: eligibility.can_cancel,
    code,
    message: code ? BLOCK_MESSAGES[code] : null,
    dispatch_state: dispatch?.state ?? null,
    window_ends_at:
      dispatch?.state === "placed" ? new Date(dispatch.window_ends_at).toISOString() : null,
    payment_kind: paymentKind(context),
    total: context.total,
    paid_online: plan.paid_online,
    wallet_used: plan.wallet_used,
    fee: cancellationFee(),
    requires_choice: plan.requires_choice,
    options: {
      wallet: plan.wallet ? { amount: plan.wallet.amount, available: plan.wallet.available } : null,
      original: plan.original
        ? {
            amount: plan.original.amount,
            fee: plan.original.fee,
            available: plan.original.available,
            ...(plan.original.unavailable_reason
              ? { unavailable_reason: plan.original.unavailable_reason }
              : {}),
          }
        : null,
    },
    eta: bankRefundEta(),
    wallet_valid_months: creditValidityMonths(),
    cancellation,
  }
}
