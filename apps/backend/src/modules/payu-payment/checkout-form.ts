import { MedusaError } from "@medusajs/framework/utils"
import type { PayuConfig } from "./config"
import { clip, formatAmount, requestHash, type PaymentRequest } from "./hash"

/**
 * The hosted-checkout form the storefront posts to PayU. Signed here with the
 * salt, which never leaves the backend; the amount and transaction id come from
 * the payment session, never from the browser. PayU's field limits apply.
 */

export type CheckoutCustomer = { email: string; firstname: string; lastname?: string | null; phone: string }

export type CheckoutForm = { action: string; method: "POST"; fields: Record<string, string> }

export function buildCheckoutForm(
  config: PayuConfig,
  input: { txnid: string; amount_paise: number; cart_id: string; customer: CheckoutCustomer; productinfo?: string }
): CheckoutForm {
  if (!config.successUrl || !config.failureUrl) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "PAYU_SUCCESS_URL and PAYU_FAILURE_URL must be set")
  const request: PaymentRequest = {
    key: config.key,
    txnid: input.txnid,
    amount: formatAmount(input.amount_paise),
    productinfo: clip(input.productinfo ?? "EYRA order", 100),
    firstname: clip(input.customer.firstname, 20) || "Customer",
    email: clip(input.customer.email, 50),
    // The cart, for PayU's dashboard; the backend finds the cart from its own records, not from this.
    udf1: clip(input.cart_id, 255),
  }
  const fields: Record<string, string> = {
    ...(request as Record<string, string>),
    lastname: clip(input.customer.lastname, 20),
    phone: clip(input.customer.phone, 50),
    surl: config.successUrl,
    furl: config.failureUrl,
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
    hash: requestHash(request, config.salt),
  }
  return { action: config.checkoutUrl, method: "POST", fields }
}
