/**
 * The tax rates and fixed money amounts that invoices and credit notes use.
 *
 * Prices include GST. The jewellery rate and HSN match the storefront's
 * JEWELRY_GST_RATE and JEWELRY_HSN_CODE, so the same two settings must be used
 * on both sides. The Cash on Delivery charge is a service, taxed at its own
 * rate under its own SAC code.
 */

const envNumber = (name: string, fallback: number, accept: (value: number) => boolean): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && accept(value) ? value : fallback
}

const envText = (name: string, fallback: string, pattern: RegExp): string => {
  const raw = (process.env[name] ?? "").trim()
  return pattern.test(raw) ? raw : fallback
}

/** GST on the silver jewellery itself, in percent. */
export function goodsGstRate(): number {
  return envNumber("JEWELRY_GST_RATE", 3, (value) => value >= 0 && value <= 40)
}

/** HSN code printed against the jewellery. */
export function goodsHsn(): string {
  return envText("JEWELRY_HSN_CODE", "7113", /^\d{4,8}$/)
}

/** GST on the Cash on Delivery charge, in percent (18%, SAC 9997). */
export function codGstRate(): number {
  return envNumber("COD_GST_RATE", 18, (value) => value >= 0 && value <= 40)
}

/** SAC printed against the Cash on Delivery charge and a retained cancellation fee. */
export function serviceSac(): string {
  return envText("SERVICE_SAC_CODE", "9997", /^\d{4,8}$/)
}

/** The flat fee kept when a delivered item is returned, or a shipped parcel is refused. */
export const REVERSE_LOGISTICS_FEE = 99

/** Days after delivery within which a return or exchange can be requested. */
export const RETURN_WINDOW_DAYS = 7

/** Months store credit from a return stays usable. */
export const STORE_CREDIT_VALIDITY_MONTHS = 12
