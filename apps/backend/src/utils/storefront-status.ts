import { callStorefront } from "./storefront"

const CACHE_MS = 10 * 60 * 1000

let cache: { at: number; problems: string[] } | null = null

/**
 * What the storefront says would stop Shiprocket working (an expired token, no
 * webhook secret, no pickup location). Asked at most every ten minutes. Says
 * nothing when the storefront cannot be reached, since that is reported on its
 * own and would only repeat.
 */
export async function storefrontShiprocketProblems(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.problems

  const reply = await callStorefront("/api/ops/shiprocket-status", {}, { timeoutMs: 8000 })
  const problems =
    reply.kind === "answered" && reply.status === 200 && Array.isArray(reply.body?.problems)
      ? (reply.body.problems as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : []
  cache = { at: Date.now(), problems }
  return problems
}

/** For tests. */
export function resetStorefrontStatusCache() {
  cache = null
}
