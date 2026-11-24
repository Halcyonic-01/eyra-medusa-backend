/**
 * PayU credentials and endpoints, from the environment only. PAYU_MODE picks
 * PayU's test or live hosts; the *_URL overrides exist for local fakes in tests.
 */

const HOSTS = {
  test: { checkout: "https://test.payu.in/_payment", api: "https://test.payu.in/merchant/postservice.php?form=2" },
  live: { checkout: "https://secure.payu.in/_payment", api: "https://info.payu.in/merchant/postservice.php?form=2" },
}

export type PayuConfig = {
  key: string
  salt: string
  mode: "test" | "live"
  checkoutUrl: string
  apiUrl: string
  /** Where PayU sends the customer back after paying (success) or not (failure). PayU allows 50 characters. */
  successUrl: string
  failureUrl: string
}

export class PayuNotConfiguredError extends Error {}

export function payuConfig(env: NodeJS.ProcessEnv = process.env): PayuConfig | null {
  const key = env.PAYU_MERCHANT_KEY?.trim()
  const salt = env.PAYU_MERCHANT_SALT?.trim()
  if (!key || !salt) return null
  const mode = env.PAYU_MODE?.trim().toLowerCase() === "live" ? "live" : "test"
  return {
    key,
    salt,
    mode,
    checkoutUrl: env.PAYU_CHECKOUT_URL?.trim() || HOSTS[mode].checkout,
    apiUrl: env.PAYU_API_URL?.trim() || HOSTS[mode].api,
    successUrl: env.PAYU_SUCCESS_URL?.trim() ?? "",
    failureUrl: env.PAYU_FAILURE_URL?.trim() ?? "",
  }
}

export function requirePayuConfig(env: NodeJS.ProcessEnv = process.env): PayuConfig {
  const config = payuConfig(env)
  if (!config) throw new PayuNotConfiguredError("PayU is not configured (PAYU_MERCHANT_KEY / PAYU_MERCHANT_SALT)")
  return config
}
