/**
 * What a Shiprocket tracking status means for us. Shiprocket sends the status as
 * text in varying case and spelling ("OUT FOR DELIVERY", "Out For Delivery",
 * "RTO_DELIVERED"), so it is normalised first. Pure, so it can be tested alone.
 */

export type StatusKind =
  /** The parcel reached the customer (or, for a reverse pickup, reached our warehouse). */
  | "delivered"
  /** The courier tried to deliver: out for delivery, undelivered, or an attempt was made. */
  | "attempted"
  /** On its way back to us after a failed or refused delivery. */
  | "rto"
  /** Back with us after a failed or refused delivery. */
  | "rto_delivered"
  /** The shipment or pickup was cancelled, lost or could not be collected. */
  | "failed"
  | "other"

export function normaliseStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
}

export function classifyStatus(status: string | null | undefined): StatusKind {
  const text = normaliseStatus(status)
  if (!text) return "other"
  if (text === "RTO DELIVERED") return "rto_delivered"
  if (text.startsWith("RTO")) return "rto"
  if (text === "DELIVERED") return "delivered"
  if (text === "OUT FOR DELIVERY" || text === "UNDELIVERED" || text === "DELIVERY ATTEMPTED" || text.includes("NDR")) {
    return "attempted"
  }
  if (
    text.includes("CANCEL") ||
    text.includes("LOST") ||
    text.includes("PICKUP EXCEPTION") ||
    text.includes("PICKUP ERROR") ||
    text.includes("DAMAGED")
  ) {
    return "failed"
  }
  return "other"
}
