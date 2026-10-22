/**
 * GST on prices that already include it, worked in whole paise so nothing
 * drifts. Pure functions: no environment, no Medusa, no clock.
 *
 * The storefront has the same rules in lib/gst.ts and lib/invoice-view.ts; both
 * are checked against the same worked examples, so an invoice and the credit
 * note that reverses it always agree to the paisa.
 *
 *   discount first:   net  = gross - discount share
 *   GST from net:     GST  = round(net x rate / (100 + rate))
 *   taxable value:    base = net - GST            (so base + GST = net, always)
 */

export const toPaise = (rupees: number): number => Math.round(rupees * 100)
export const fromPaise = (paise: number): number => paise / 100

/** GST taken out of an inclusive amount, in paise. `base + gst === amount`. */
export function extractGstPaise(amountPaise: number, ratePercent: number): { gst: number; base: number } {
  const gst = Math.round((amountPaise * ratePercent) / (100 + ratePercent))
  return { gst, base: amountPaise - gst }
}

/**
 * Splits a total across weights in whole paise, proportionally, so the parts
 * add up to the total exactly. The paise left over after rounding down go, one
 * each, to the largest remainders (the earlier line wins a tie).
 */
export function allocateProportionally(totalPaise: number, weightsPaise: readonly number[]): number[] {
  const weightSum = weightsPaise.reduce((sum, weight) => sum + weight, 0)
  if (totalPaise <= 0 || weightSum <= 0) return weightsPaise.map(() => 0)

  const shares = weightsPaise.map((weight) => {
    const exact = (totalPaise * weight) / weightSum
    const floor = Math.floor(exact)
    return { floor, remainder: exact - floor }
  })
  let left = totalPaise - shares.reduce((sum, share) => sum + share.floor, 0)
  const order = shares
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  const result = shares.map((share) => share.floor)
  for (const { index } of order) {
    if (left <= 0) break
    result[index] += 1
    left -= 1
  }
  return result
}

export type TaxSplit = { cgst: number; sgst: number; igst: number }

/**
 * The GST as it is itemised: inside the seller's state half is CGST and half
 * SGST (an odd paisa goes to CGST, so the halves add up); to any other state it
 * is all IGST.
 */
export function splitGstPaise(gstPaise: number, interState: boolean): TaxSplit {
  if (interState) return { cgst: 0, sgst: 0, igst: gstPaise }
  const cgst = Math.round(gstPaise / 2)
  return { cgst, sgst: gstPaise - cgst, igst: 0 }
}

export const isInterState = (buyerState: string, sellerState: string): boolean =>
  buyerState.trim().toLowerCase() !== sellerState.trim().toLowerCase()

export type ProductLineInput = { id: string; unit_price: number; quantity: number }

export type ProductLineAmounts = {
  id: string
  quantity: number
  /** Price of the whole line before any discount, GST included. */
  gross: number
  /** This line's share of the order discount. */
  discount: number
  /** What the customer pays for the line: gross less discount, GST included. */
  net: number
  base: number
  gst: number
  cgst: number
  sgst: number
  igst: number
}

/**
 * Per-line amounts for the products of an order. The order's discount is
 * spread over the lines in proportion to their price before tax is worked out,
 * so each line's tax mirrors its share of the net invoice. A free line (such as
 * the complimentary tote) carries no discount and no tax.
 */
export function productLineAmounts(
  lines: readonly ProductLineInput[],
  discountRupees: number,
  ratePercent: number,
  interState: boolean
): ProductLineAmounts[] {
  const gross = lines.map((line) => toPaise(line.unit_price * line.quantity))
  const grossTotal = gross.reduce((sum, value) => sum + value, 0)
  const discount = Math.min(Math.max(toPaise(discountRupees), 0), grossTotal)
  const shares = allocateProportionally(discount, gross)

  return lines.map((line, index) => {
    const net = gross[index] - shares[index]
    const { gst, base } = extractGstPaise(net, ratePercent)
    const split = splitGstPaise(gst, interState)
    return {
      id: line.id,
      quantity: line.quantity,
      gross: fromPaise(gross[index]),
      discount: fromPaise(shares[index]),
      net: fromPaise(net),
      base: fromPaise(base),
      gst: fromPaise(gst),
      cgst: fromPaise(split.cgst),
      sgst: fromPaise(split.sgst),
      igst: fromPaise(split.igst),
    }
  })
}

export type ChargeAmounts = {
  /** The charge as the customer pays it, tax included. */
  amount: number
  base: number
  gst: number
  cgst: number
  sgst: number
  igst: number
}

/** A flat charge that includes its GST (the Cash on Delivery charge, a retained fee). */
export function inclusiveChargeAmounts(amountRupees: number, ratePercent: number, interState: boolean): ChargeAmounts {
  const amount = toPaise(amountRupees)
  const { gst, base } = extractGstPaise(amount, ratePercent)
  const split = splitGstPaise(gst, interState)
  return {
    amount: fromPaise(amount),
    base: fromPaise(base),
    gst: fromPaise(gst),
    cgst: fromPaise(split.cgst),
    sgst: fromPaise(split.sgst),
    igst: fromPaise(split.igst),
  }
}
