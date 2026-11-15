import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import { REVIEW_LINK_DAYS } from "./constants"

/**
 * Review links. The link carries a token made from the request id, a random
 * nonce and a server secret (HMAC-SHA256). Only the token's sha256 is stored, so
 * a copy of the database cannot be turned into working links, and the same link
 * can be rebuilt for the reminder. Issuing a new link changes the nonce, which
 * retires the old one.
 */

type Env = Record<string, string | undefined>

/** REVIEW_LINK_SECRET, or the JWT secret Medusa already has outside production. */
export function linkSecret(env: Env = process.env): string {
  const own = env.REVIEW_LINK_SECRET?.trim()
  if (own) return own
  if (env.NODE_ENV === "production") {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "REVIEW_LINK_SECRET must be set in production")
  }
  return env.JWT_SECRET?.trim() || "eyra-review-links-development"
}

export const newNonce = (): string => randomBytes(16).toString("hex")

export function linkToken(secret: string, requestId: string, nonce: string): string {
  return createHmac("sha256", secret).update(`${requestId}.${nonce}`).digest("base64url")
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

/** A token looks like one we issue: 43 url-safe characters. Anything else is not looked up. */
export const wellFormedToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)

export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const linkExpiry = (issuedAt: Date): Date => new Date(issuedAt.getTime() + REVIEW_LINK_DAYS * 24 * 3600 * 1000)

export type LinkState = "ok" | "expired" | "used"

export function linkState(
  request: { token_expires_at: Date | string; token_used_at?: Date | string | null },
  now: Date = new Date()
): LinkState {
  if (request.token_used_at) return "used"
  if (new Date(request.token_expires_at).getTime() <= now.getTime()) return "expired"
  return "ok"
}

/**
 * Where the review page lives: REVIEW_LINK_BASE_URL, or the storefront the
 * backend already calls (the origin of STOREFRONT_REVALIDATE_URL).
 */
export function reviewLinkBase(env: Env = process.env): string | null {
  const explicit = env.REVIEW_LINK_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, "")
  const revalidate = env.STOREFRONT_REVALIDATE_URL?.trim()
  if (!revalidate) return null
  try {
    return new URL(revalidate).origin
  } catch {
    return null
  }
}

export function reviewLinkUrl(base: string, token: string): string {
  return `${base}/review/${token}`
}
