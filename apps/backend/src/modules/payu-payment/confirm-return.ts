import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { PAYMENT_SNAPSHOT_MODULE } from "../payment-snapshot"
import { findAttempt } from "../payment-snapshot/attempts"
import { getGateway } from "../payment-snapshot/gateways"
import { loadCartOrder, settleLatePayments } from "../payment-snapshot/late-payments"
import type PaymentSnapshotModuleService from "../payment-snapshot/service"
import { PAYU_PROVIDER_ID } from "./attempt"
import { payuConfig } from "./config"
import { responseHashValid, type PayuResponse } from "./hash"

export type PayuReturnOutcome = {
  cart_id: string
  /** order: placed. pending: PayU has not decided yet. failed: nothing was taken. refunded / processing: see the late-payment settle. */
  status: "order" | "pending" | "failed" | "refunded" | "processing"
  order_id: string | null
}

/**
 * What the customer coming back from PayU's hosted checkout leads to. The
 * posted fields only have to carry a valid PayU hash and name one of our own
 * attempts; whether anything was paid is asked of PayU (verify_payment). A paid
 * attempt goes through the same path as every other completion: the
 * late-payment settle first, then Medusa's own cart completion.
 */
export async function confirmPayuReturn(container: MedusaContainer, fields: PayuResponse): Promise<PayuReturnOutcome> {
  const config = payuConfig()
  if (!config) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "PayU is not available")
  if (!fields.txnid || !responseHashValid(fields, config.key, config.salt)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "This PayU response could not be verified")
  }
  const attempt = await findAttempt(container, PAYU_PROVIDER_ID, fields.txnid)
  if (!attempt.found) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Unknown PayU transaction")
  const cartId = attempt.cart_id

  const existing = await loadCartOrder(container, cartId)
  if (existing?.attempt_refs.includes(fields.txnid)) return { cart_id: cartId, status: "order", order_id: existing.id }

  const paid = await getGateway(PAYU_PROVIDER_ID)!.fetchAttempt(fields.txnid)
  const own = (paid?.payments ?? []).filter((p) => p.attempt_ref === fields.txnid)
  if (own.some((p) => p.status === "pending")) return { cart_id: cartId, status: "pending", order_id: null }
  if (!own.some((p) => p.status === "captured" || p.status === "authorized")) return { cart_id: cartId, status: "failed", order_id: null }

  await settleLatePayments(container, cartId, { complete: true })
  let order = await loadCartOrder(container, cartId)
  if (!order) {
    const { errors } = await completeCartWorkflow(container).run({ input: { id: cartId }, throwOnError: false })
    if (errors?.length) {
      container.resolve(ContainerRegistrationKeys.LOGGER).error(`[payu] cart ${cartId} could not be completed on return: ${(errors[0].error as Error)?.message}`)
    }
    order = await loadCartOrder(container, cartId)
  }
  if (order?.attempt_refs.includes(fields.txnid)) return { cart_id: cartId, status: "order", order_id: order.id }

  const service = container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
  const rows = (await service.listLateRazorpayPayments({ provider_id: PAYU_PROVIDER_ID, provider_ref: fields.txnid })) as unknown as { status: string }[]
  if (rows.some((row) => row.status === "refunding" || row.status === "refunded")) return { cart_id: cartId, status: "refunded", order_id: order?.id ?? null }
  return { cart_id: cartId, status: "processing", order_id: order?.id ?? null }
}
