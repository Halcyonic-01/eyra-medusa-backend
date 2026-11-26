/**
 * Payment settings that would let money move wrongly or not at all in
 * production. Shown with the other configuration problems in the admin and
 * the dispatch job's log. Pure: reads only the environment it is given.
 */

type Env = Record<string, string | undefined>

const isProduction = (env: Env) => env.NODE_ENV === "production"

/** PayU's own hosts; an override to anything else is only for local fakes. */
const PAYU_HOSTS = ["secure.payu.in", "test.payu.in", "info.payu.in"]

export function payuHostAllowed(url: string | undefined): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && PAYU_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/** Reasons PayU must not run in live mode with these settings; empty when it may. */
export function payuLiveProblems(env: Env): string[] {
  if (env.PAYU_MODE?.trim().toLowerCase() !== "live") return []
  const problems: string[] = []
  for (const name of ["PAYU_CHECKOUT_URL", "PAYU_API_URL"]) {
    if (!payuHostAllowed(env[name]?.trim())) problems.push(`${name} points outside PayU while PAYU_MODE is live; PayU is switched off`)
  }
  for (const name of ["PAYU_SUCCESS_URL", "PAYU_FAILURE_URL"]) {
    // Unset is reported separately and only stops new PayU payments; a set plain-http address switches PayU off.
    const value = env[name]?.trim() ?? ""
    if (value && !value.startsWith("https://")) problems.push(`${name} must be an https address while PAYU_MODE is live; PayU is switched off`)
  }
  return problems
}

/** True when refunds may use the REFUND_GATEWAY=fake stand-ins: never in production. */
export function fakeRefundsAllowed(env: Env): boolean {
  return !isProduction(env)
}

export function paymentConfigProblems(env: Env = process.env): string[] {
  const problems: string[] = []
  const prod = isProduction(env)

  if (!(env.RAZORPAY_TEST_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET)) {
    problems.push("RAZORPAY_WEBHOOK_SECRET is not set, so Razorpay webhooks are refused and only the sweeps confirm payments")
  }
  if (prod) {
    const testVars = ["RAZORPAY_TEST_KEY_ID", "RAZORPAY_TEST_KEY_SECRET", "RAZORPAY_TEST_WEBHOOK_SECRET", "RAZORPAY_TEST_ACCOUNT"].filter((name) => env[name])
    if (testVars.length) problems.push(`${testVars.join(", ")} set in production: they take precedence over the live Razorpay settings`)
    if ((env.RAZORPAY_TEST_KEY_ID ?? env.RAZORPAY_ID ?? "").startsWith("rzp_test_")) {
      problems.push("Razorpay is using a test key (rzp_test_): no real payments are taken")
    }
    if ((env.REFUND_GATEWAY ?? "").trim().toLowerCase().startsWith("fake")) {
      problems.push("REFUND_GATEWAY is set to a test stand-in in production; it is ignored and real refunds are used")
    }
    if (env.PAYU_MERCHANT_KEY && env.PAYU_MODE?.trim().toLowerCase() !== "live") {
      problems.push("PayU is in test mode (PAYU_MODE is not live): no real PayU payments are taken")
    }
  }
  if (env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT) {
    for (const name of ["PAYU_SUCCESS_URL", "PAYU_FAILURE_URL"]) {
      const value = env[name]?.trim() ?? ""
      if (!value) problems.push(`${name} is not set, so PayU cannot be offered`)
      else if (value.length > 50) problems.push(`${name} is longer than the 50 characters PayU accepts`)
    }
  }
  problems.push(...payuLiveProblems(env))
  return problems
}
