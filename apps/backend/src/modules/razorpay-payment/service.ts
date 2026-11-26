import type { RefundPaymentInput, RefundPaymentOutput } from "@medusajs/framework/types"
import { BigNumber, MedusaError } from "@medusajs/framework/utils"
// The plugin ships JavaScript only.
const plugin = require("medusa-plugin-razorpay-v2/providers/payment-razorpay/src/services") as {
  RazorpayProviderService: new (...args: any[]) => { refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> }
}
const RazorpayProviderService = plugin.RazorpayProviderService as unknown as (new (...args: any[]) => {
  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput>
}) & { identifier: string }

/** Pure: the refund amount in rupees, whatever shape Medusa passes it in (a number, a string, a BigNumber or its raw form). */
export function refundAmount(amount: unknown): number {
  return new BigNumber(amount as never).numeric
}

/**
 * The plugin's Razorpay provider, with refunds fixed. Medusa passes the refund
 * amount in its raw form ({ value, precision }); the plugin reads it with
 * parseFloat(amount.toString()), gets NaN, matches no payment and returns as if
 * it had refunded. Medusa then records a refund that never happened (admin
 * Cancel and admin Refund). Here the amount is converted first, and a refund the
 * plugin still did not make fails loudly instead of being recorded.
 */
export class EyraRazorpayProviderService extends RazorpayProviderService {
  static identifier = RazorpayProviderService.identifier

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const amount = refundAmount(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Razorpay refund amount is not valid: ${String(input.amount)}`)
    }
    const result = await super.refundPayment({ ...input, amount })
    if (!(result?.data as { razorpayRefundSession?: unknown } | undefined)?.razorpayRefundSession) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Razorpay has no captured payment of at least ₹${amount} on this order to refund; nothing was refunded`
      )
    }
    return result
  }
}
