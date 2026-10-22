import { fileStorageProblems } from "../../utils/file-storage"
import { jwtExpiry } from "../../utils/jwt-expiry"
/**
 * Settings for holding an order before its shipment is created. They are read
 * each time, so they can change without a code change.
 */

/** ORDER_DISPATCH_ENABLED=false turns the whole mechanism off. On by default. */
export function dispatchEnabled(): boolean {
  return process.env.ORDER_DISPATCH_ENABLED?.trim().toLowerCase() !== "false"
}

/**
 * Minutes between an order being placed and its shipment being created, which
 * is also how long the customer can cancel. 0 creates the shipment straight
 * away. Defaults to 0 so nothing is held until cancelling is switched on.
 */
export function holdMinutes(): number {
  const raw = process.env.ORDER_CANCEL_WINDOW_MINUTES
  if (raw === undefined || raw.trim() === "") {
    return 0
  }
  const minutes = Number(raw)
  return Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : 0
}

/**
 * Settings without which orders cannot ship, the team cannot be told, or files
 * such as invoice PDFs would be lost. The first go through the storefront, so
 * when they are missing nothing is emailed either: all are shown in the admin
 * and written to the log.
 */
export function dispatchConfigProblems(): string[] {
  const problems: string[] = []
  if (!process.env.STOREFRONT_REVALIDATE_URL) {
    problems.push("STOREFRONT_REVALIDATE_URL is not set, so shipments cannot be created and no team emails are sent")
  }
  if (!process.env.STOREFRONT_REVALIDATE_SECRET) {
    problems.push("STOREFRONT_REVALIDATE_SECRET is not set, so shipments cannot be created and no team emails are sent")
  }
  if (!process.env.STOREFRONT_SHIPMENT_SECRET) {
    problems.push("STOREFRONT_SHIPMENT_SECRET is not set, so shipments are created with the shared secret instead of their own")
  }
  problems.push(...fileStorageProblems(process.env))

  // The backend's own Shiprocket token only prices live courier rates, which
  // customers are not charged (prepaid ships free, Cash on Delivery has its own
  // charge), so an expired one costs nothing but the rate estimate.
  const rateTokenExpiry = jwtExpiry(process.env.SHIPROCKET_API_TOKEN)
  if (rateTokenExpiry && rateTokenExpiry.getTime() <= Date.now()) {
    problems.push(
      `SHIPROCKET_API_TOKEN on the backend expired on ${rateTokenExpiry.toISOString().slice(0, 10)}. Live courier rates fall back to the fixed estimate; customer shipping charges are not affected.`
    )
  }
  return problems
}

/** After this many failed attempts an order waits for staff ("Ship now"). */
export const MAX_DISPATCH_ATTEMPTS = 6

/** Minutes to wait before attempt number `attempts + 1`: 1, 2, 5, 10, 20, then 30. */
export function retryDelayMinutes(attempts: number): number {
  const steps = [1, 2, 5, 10, 20, 30]
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1]
}

/** A claimed order untouched for this long is treated as an interrupted attempt. */
export const STALLED_AFTER_MINUTES = 10

/** Letters and digits only, up to 6 characters, so a number stays within 16. */
export function invoicePrefix(): string {
  const raw = (process.env.INVOICE_PREFIX ?? "EYRA").trim().toUpperCase()
  return /^[A-Z0-9]{1,6}$/.test(raw) ? raw : "EYRA"
}

/**
 * What is kept when an order is cancelled before it ships: nothing. A cancelled
 * order is refunded in full, to the payment method it was paid with. (The ₹99
 * reverse logistics fee applies only to parcels that already shipped.)
 */
export function cancellationFee(): number {
  return 0
}

/** How long a refund to the original payment method takes, as shown to the customer. */
export function bankRefundEta(): string {
  return process.env.BANK_REFUND_ETA?.trim() || "5 to 7 working days"
}
