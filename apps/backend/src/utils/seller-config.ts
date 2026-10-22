/**
 * The registered seller, as printed on credit notes and exported for GSTR-1.
 * The same SELLER_* settings the storefront uses for the tax invoice, with the
 * same defaults, so a credit note always names the seller its invoice did.
 * Nothing is invented: a missing GSTIN is reported and no credit note is issued.
 */

const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

// A blank setting counts as unset, so the same default applies as when it is missing.
const text = (name: string, fallback: string): string => process.env[name]?.trim() || fallback

export type Seller = {
  legalName: string
  gstin: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  pincode: string
}

export function seller(): Seller {
  return {
    legalName: text("SELLER_LEGAL_NAME", "EYRA JEWELS PRIVATE LIMITED"),
    gstin: text("SELLER_GSTIN", "").trim().toUpperCase(),
    addressLine1: text("SELLER_ADDRESS_LINE1", "Ward No. 12, Main Road"),
    addressLine2: text("SELLER_ADDRESS_LINE2", ""),
    city: text("SELLER_CITY", "Garhwa"),
    state: text("SELLER_STATE", "Jharkhand"),
    pincode: text("SELLER_PINCODE", "822114"),
  }
}

/** What stops a credit note being valid: a missing or malformed seller GSTIN. Empty when all is well. */
export function sellerProblems(value: Seller = seller()): string[] {
  if (!value.gstin) return ["SELLER_GSTIN is not set, so no credit note can be issued."]
  if (!GSTIN_FORMAT.test(value.gstin)) return ["SELLER_GSTIN is not a valid 15-character GSTIN."]
  return []
}
