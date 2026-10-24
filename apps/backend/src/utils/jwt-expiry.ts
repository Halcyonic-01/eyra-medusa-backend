/**
 * When a JWT stops being valid, read from its payload. Nothing is verified:
 * this only answers "has it run out", so a token can be flagged before it
 * fails. It never returns or logs the token.
 */
export function jwtExpiry(token: string | null | undefined): Date | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null
  } catch {
    return null
  }
}
