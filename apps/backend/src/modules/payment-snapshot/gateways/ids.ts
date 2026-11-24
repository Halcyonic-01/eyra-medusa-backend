/**
 * Which Medusa payment providers take the money online before an order is
 * placed. Pure, so checkout rules can use it without loading any provider code.
 * A provider joins the list when its gateway is registered (see ./index).
 */

export const RAZORPAY_PROVIDER_ID = "pp_razorpay_razorpay"
/** Cash on Delivery: nothing is collected up front. */
export const COD_PROVIDER_ID = "pp_system_default"

const prepaid = new Set<string>([RAZORPAY_PROVIDER_ID])

export function isPrepaidProvider(providerId: string | null | undefined): boolean {
  return Boolean(providerId) && prepaid.has(providerId as string)
}

export function prepaidProviderIds(): string[] {
  return [...prepaid]
}

export function addPrepaidProvider(providerId: string) {
  prepaid.add(providerId)
}

/**
 * One lock per cart for everything that opens, replaces or settles an online
 * payment attempt, whichever provider it is with. The text is the one the
 * Razorpay-only release used, and must stay so: during a rolling deploy old and
 * new instances then hold the same lock for the same cart. Settling takes it
 * together with Medusa's own cart lock (the cart id), always in that order.
 */
export const checkoutLockKey = (cartId: string) => `razorpay-checkout:${cartId}`
