import { allocateProportionally, fromPaise, toPaise } from "../../utils/gst-math"

/**
 * What a customer paid for part of an order, GST included: the order's discount
 * is spread over its lines in proportion to their price (the same split the tax
 * invoice uses), and a line returned in part is taken in proportion. Free lines
 * (the complimentary tote) are worth nothing. This is the figure shown for a
 * request; the credit note, worked out when the item arrives, has the final say.
 */

export type PricedLine = { item_id: string; unit_price: number; quantity: number }

/** What the customer paid for each whole line, after its share of the discount. */
export function paidValues(lines: readonly PricedLine[], discountRupees: number): Map<string, number> {
  const gross = lines.map((line) => toPaise(line.unit_price * line.quantity))
  const total = gross.reduce((sum, value) => sum + value, 0)
  const discount = Math.min(Math.max(toPaise(discountRupees), 0), total)
  const shares = allocateProportionally(discount, gross)
  const result = new Map<string, number>()
  lines.forEach((line, index) => result.set(line.item_id, gross[index] - shares[index]))
  return result
}

/** The paid value of `quantity` units of a line, in rupees. */
export function paidValueOf(netPaise: number, ordered: number, quantity: number): number {
  if (quantity >= ordered) return fromPaise(netPaise)
  return fromPaise(Math.round((netPaise * quantity) / ordered))
}
