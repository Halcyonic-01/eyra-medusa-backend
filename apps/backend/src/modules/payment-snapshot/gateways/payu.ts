import { Modules } from "@medusajs/framework/utils"
import { verifyPayment } from "../../payu-payment/api"
import { PAYU_PROVIDER_ID, payuAttempt, sessionPayu } from "../../payu-payment/attempt"
import { payuRefunds } from "../../payu-payment/refunds"
import type { PrepaidGateway } from "./types"

/** PayU hosted checkout: an attempt is a PayU transaction id. */
export const payuGateway: PrepaidGateway = {
  provider_id: PAYU_PROVIDER_ID,
  name: "PayU",
  sessionRef: (session) => sessionPayu(session)?.txnid ?? null,
  sessionAttemptAmount: (session) => Number(sessionPayu(session)?.amount_paise ?? Number.NaN),

  async fetchAttempt(ref) {
    return payuAttempt(ref, await verifyPayment(ref))
  },

  /** The provider's update keeps a transaction marked `rebind` instead of opening a new one. */
  async rebindSession(container, session, attempt, amount, currencyCode) {
    await container.resolve(Modules.PAYMENT).updatePaymentSession({
      id: session.id,
      amount,
      currency_code: currencyCode,
      data: { payu: { txnid: attempt.ref, amount_paise: attempt.amount_paise, currency_code: "inr", rebind: true } },
    } as never)
  },

  refunds: () => payuRefunds,
}
