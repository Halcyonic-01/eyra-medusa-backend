import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { AbstractPaymentProvider, BigNumber, MedusaError, PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import { verifyPayment } from "./api"
import { sessionPayu, type PayuSessionData } from "./attempt"
import { payuConfig } from "./config"
import { newTxnId, responseHashValid, toPaise, transactionState, type PayuResponse, type PayuState, type PayuTransaction } from "./hash"
import { payuRefunds } from "./refunds"

type InjectedDependencies = { logger: Logger }

const toNumber = (value: unknown) => new BigNumber(value as never).numeric

/**
 * PayU hosted checkout as a Medusa payment provider (pp_payu_payu).
 *
 * A session is one PayU transaction id (txnid). Nothing is created at PayU up
 * front: the storefront posts the hosted-checkout form the backend signs (see
 * /store/carts/:id/payu-session). Whether it was paid is only ever taken from
 * PayU's verify_payment, read with the server's own key and salt; nothing the
 * browser or a webhook says is trusted on its own. PayU captures on success, so
 * a successful transaction is reported as captured.
 */
class PayuProviderService extends AbstractPaymentProvider {
  static identifier = "payu"

  protected logger_: Logger

  constructor(container: InjectedDependencies, options: Record<string, unknown> = {}) {
    super(container, options)
    this.logger_ = container.logger
  }

  private payu(data: Record<string, unknown> | undefined): PayuSessionData["payu"] {
    const payu = sessionPayu({ data })
    if (!payu) throw new MedusaError(MedusaError.Types.INVALID_DATA, "This PayU payment has no transaction id")
    return payu
  }

  /** PayU's word on the transaction. Throws PayuUnavailableError when PayU cannot be asked. */
  private async read(payu: PayuSessionData["payu"]): Promise<{ detail: PayuTransaction | null; state: PayuState; paid_paise: number }> {
    const detail = await verifyPayment(payu.txnid)
    const state = transactionState(detail)
    return { detail, state, paid_paise: detail ? toPaise(detail.transaction_amount ?? detail.amt) : 0 }
  }

  private status(state: PayuState, paidPaise: number, payu: PayuSessionData["payu"]): PaymentSessionStatus {
    // A payment for a different amount than this session asks for is never taken as paid.
    if ((state === "captured" || state === "authorized") && paidPaise !== payu.amount_paise) return PaymentSessionStatus.ERROR
    if (state === "captured") return PaymentSessionStatus.CAPTURED
    if (state === "authorized") return PaymentSessionStatus.AUTHORIZED
    if (state === "pending") return PaymentSessionStatus.PENDING
    if (state === "failed") return PaymentSessionStatus.ERROR
    return PaymentSessionStatus.REQUIRES_MORE
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    if (!payuConfig()) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "PayU is not set up on this store")
    if ((input.currency_code ?? "").toLowerCase() !== "inr") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayU payments are taken in INR only")
    }
    const amountPaise = Math.round(toNumber(input.amount) * 100)
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayU amount")
    const txnid = newTxnId()
    const data: PayuSessionData = { payu: { txnid, amount_paise: amountPaise, currency_code: "inr" } }
    return { id: txnid, data, status: PaymentSessionStatus.PENDING }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const payu = this.payu(input.data)
    const { detail, state, paid_paise } = await this.read(payu)
    return {
      status: this.status(state, paid_paise, payu),
      data: { payu: { ...payu, mihpayid: detail?.mihpayid ? String(detail.mihpayid) : payu.mihpayid ?? null, state } },
    }
  }

  /** PayU captures on success; nothing to do. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data }
  }

  /**
   * Called when Medusa gives up on a payment it authorized. An unpaid PayU
   * transaction needs nothing; a paid one is refunded in full, and a refund
   * that cannot be confirmed fails loudly instead of being reported as done.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const payu = this.payu(input.data)
    const { detail, state, paid_paise } = await this.read(payu)
    if (state !== "captured" || !detail?.mihpayid) return { data: { payu: { ...payu, state } } }
    const result = await payuRefunds.refund({
      order_id: payu.txnid,
      payment_ref: String(detail.mihpayid),
      attempt_ref: payu.txnid,
      amount: paid_paise / 100,
      fee: 0,
      cancellation_id: `cancel-${payu.txnid}`,
      since_ms: Date.now(),
    })
    if (!result.ok) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `PayU refund on cancel failed: ${result.error}`)
    return { data: { payu: { ...payu, state, cancel_refund_id: result.refund_id } } }
  }

  /** A PayU transaction cannot be withdrawn; if it is paid later, the late-payment settle deals with it. */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const payu = this.payu(input.data)
    const { state, paid_paise } = await this.read(payu)
    return { status: this.status(state, paid_paise, payu), data: { payu: { ...payu, state } } }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const payu = this.payu(input.data)
    const amount = toNumber(input.amount)
    const key = (input.context as { idempotency_key?: string } | undefined)?.idempotency_key ?? `${payu.txnid}-${Math.round(amount * 100)}`
    const result = await payuRefunds.refund({
      order_id: payu.txnid,
      payment_ref: payu.mihpayid ?? null,
      attempt_ref: payu.txnid,
      amount,
      fee: 0,
      cancellation_id: `medusa-${key}`,
      since_ms: Date.now(),
    })
    if (!result.ok) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `PayU refund failed: ${result.error}`)
    return { data: { payu: { ...payu, last_refund_id: result.refund_id } } }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const payu = this.payu(input.data)
    const { detail, state } = await this.read(payu)
    return { data: { payu: { ...payu, state, mihpayid: detail?.mihpayid ? String(detail.mihpayid) : payu.mihpayid ?? null } } }
  }

  /**
   * A changed amount gets a new transaction id, so a form already posted for
   * the old amount can never complete this session; the old one, if paid,
   * is a late payment. The late-payment rebind is the one caller that keeps
   * a given transaction (marked `rebind`).
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const given = sessionPayu({ data: input.data })
    const amountPaise = Math.round(toNumber(input.amount) * 100)
    if (given?.rebind) {
      const { rebind: _rebind, ...payu } = given
      return { data: { payu: { ...payu, amount_paise: amountPaise } } }
    }
    if (given && given.amount_paise === amountPaise) return { data: input.data }
    return { data: { payu: { txnid: newTxnId(), amount_paise: amountPaise, currency_code: "inr" } } }
  }

  /**
   * Only acts on a webhook the guard in front of /hooks/payment/payu_payu let
   * through: its hash checked and its session found in our own records
   * (eyra_session_id). What happened is then asked of PayU itself.
   */
  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const config = payuConfig()
    const body = (payload.data ?? {}) as PayuResponse & { eyra_session_id?: string }
    const sessionId = body.eyra_session_id
    if (!config || !sessionId || !body.txnid || !responseHashValid(body, config.key, config.salt)) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    const detail = await verifyPayment(body.txnid)
    const state = transactionState(detail)
    const amount = detail ? toPaise(detail.transaction_amount ?? detail.amt) / 100 : 0
    if (state === "captured") return { action: PaymentActions.SUCCESSFUL, data: { session_id: sessionId, amount } }
    if (state === "authorized") return { action: PaymentActions.AUTHORIZED, data: { session_id: sessionId, amount } }
    if (state === "failed") return { action: PaymentActions.FAILED, data: { session_id: sessionId, amount } }
    return { action: PaymentActions.NOT_SUPPORTED }
  }
}

export default PayuProviderService
