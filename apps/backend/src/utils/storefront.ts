/**
 * Calls back into the storefront, which owns the email templates and the
 * email provider. It reuses the storefront URL and secret that product
 * revalidation already needs, so there is nothing extra to configure:
 *
 *   STOREFRONT_REVALIDATE_URL     e.g. https://eyra.org.in/api/revalidate
 *   STOREFRONT_REVALIDATE_SECRET  shared secret, sent as x-revalidate-secret
 *
 * Without them this does nothing, and says so in the log.
 */
export type StorefrontResult = "sent" | "skipped" | "failed"

export async function postToStorefront(
  path: string,
  payload: Record<string, unknown>,
  log: { info: (message: string) => void; error: (message: string) => void }
): Promise<StorefrontResult> {
  const revalidateUrl = process.env.STOREFRONT_REVALIDATE_URL
  const secret = process.env.STOREFRONT_REVALIDATE_SECRET
  if (!revalidateUrl || !secret) {
    log.info(`[storefront] STOREFRONT_REVALIDATE_URL or _SECRET not set, skipping ${path}`)
    return "skipped"
  }

  try {
    const res = await fetch(new URL(path, revalidateUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      log.error(`[storefront] ${path} answered ${res.status}`)
      return "failed"
    }
    return "sent"
  } catch (error) {
    log.error(`[storefront] could not reach ${path}: ${(error as Error).message}`)
    return "failed"
  }
}
