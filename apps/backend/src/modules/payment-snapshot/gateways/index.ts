import { registerRefundGateway } from "../../order-dispatch/refund-gateway"
import { addPrepaidProvider, isPrepaidProvider } from "./ids"
import { razorpayGateway } from "./razorpay"
import type { PrepaidGateway } from "./types"

export * from "./ids"
export * from "./types"

/** Every online provider the shared payment logic can work with, by Medusa provider id. */
const gateways = new Map<string, PrepaidGateway>([[razorpayGateway.provider_id, razorpayGateway]])

/** Adds an online provider: it becomes prepaid for checkout rules and its refunds are used for its orders. */
export function registerGateway(gateway: PrepaidGateway) {
  gateways.set(gateway.provider_id, gateway)
  addPrepaidProvider(gateway.provider_id)
  registerRefundGateway(gateway.provider_id, gateway.refunds())
}

export function getGateway(providerId: string | null | undefined): PrepaidGateway | null {
  if (!providerId || !isPrepaidProvider(providerId)) return null
  return gateways.get(providerId) ?? null
}

/** The gateway of a session and the attempt it pays, or nulls for COD and unknown providers. */
export function sessionAttempt(session: { provider_id?: string | null; data?: Record<string, unknown> | null } | null | undefined) {
  const gateway = getGateway(session?.provider_id)
  return { gateway, ref: gateway ? gateway.sessionRef(session) : null }
}
