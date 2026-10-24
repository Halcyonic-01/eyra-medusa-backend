import {
  extractGstPaise,
  fromPaise,
  inclusiveChargeAmounts,
  isInterState,
  productLineAmounts,
  splitGstPaise,
  toPaise,
} from "../../utils/gst-math"
import { gstStateCode } from "../../utils/gst-state-codes"
import type { Seller } from "../../utils/seller-config"

/**
 * The credit note itself, worked out from the original order and what is being
 * reversed. Pure: no database, no clock, no number (the number is given when the
 * note is saved). Everything is whole paise inside, rupees in the document.
 *
 *  - The discount was spread over the invoice lines before tax, so each returned
 *    line is reversed at its own net value, with its own GST taken out of that.
 *  - A line returned in part is reversed in proportion; the last unit takes
 *    whatever remains of the line, so the notes for one line add up to the line
 *    exactly, to the paisa.
 *  - The Cash on Delivery charge (18% GST, SAC 9997) is reversed only when the
 *    caller says so: in full, once.
 *  - The ₹99 reverse logistics fee kept from a return is a service: it includes
 *    18% GST (SAC 9997), shown on the note as taxable value plus CGST and SGST,
 *    or IGST, and is kept back from what the customer gets. An exchange has no fee.
 */

export type CreditNoteKind = "return" | "exchange" | "cancellation" | "rto"

export type OriginalLine = {
  item_id: string
  title: string
  variant_title: string | null
  /** Units on the invoice. */
  quantity: number
  unit_price: number
}

/** What earlier credit notes on the same order already reversed, per line. */
export type PriorCredit = {
  item_id: string
  quantity: number
  net_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
}

export type CreditNoteInput = {
  kind: CreditNoteKind
  reason: string
  order: {
    id: string
    display_id: number
    discount_total: number
    /** The Cash on Delivery charge on the invoice, 0 for prepaid. */
    cod_charge: number
    lines: OriginalLine[]
    /** No money was collected for the order (Cash on Delivery, never delivered), so there is nothing to refund. */
    nothing_paid?: boolean
  }
  buyer: { name: string; state: string; gstin: string | null }
  seller: Seller
  invoice: { number: string; issued_at: Date }
  goods: { rate: number; hsn: string }
  service: { rate: number; sac: string }
  returned: { item_id: string; quantity: number }[]
  /** Reverse the Cash on Delivery charge too. */
  reverse_cod: boolean
  /** Kept back from what the customer gets, in rupees (the reverse logistics fee). */
  deduction: number
  prior: PriorCredit[]
  return_request_id: string | null
}

export type CreditNoteLine = {
  item_id: string
  hsn_sac: string
  description: string
  quantity: number
  taxable_value: number
  gst_rate: number
  cgst: number
  sgst: number
  igst: number
  total: number
}

export type CreditNoteDocument = {
  credit_note_number: string | null
  credit_note_date: string | null
  original_invoice_number: string
  original_invoice_date: string
  kind: CreditNoteKind
  reason: string
  order: { id: string; display_id: number }
  seller: { legal_name: string; gstin: string; address: string[]; state: string; state_code: string }
  customer_details: { name: string; gstin: string | null; state: string; state_code: string }
  place_of_supply: { state: string; state_code: string; tax_type: "CGST+SGST" | "IGST" }
  line_items: CreditNoteLine[]
  totals: { taxable_value: number; cgst: number; sgst: number; igst: number; total_tax: number; total: number }
  adjustments: {
    reverse_logistics_fee_deduction: number
    net_store_credit_issued: number
    net_refund_amount: number
    credit_method: "store_credit" | "refund" | "exchange_adjustment" | "none"
    /** The fee and the 18% GST inside it, when a fee was kept or paid. */
    fee: FeeTax | null
  }
  currency: "INR"
}

export type FeeTax = {
  type: "reverse_logistics"
  description: string
  sac: string
  gst_rate: number
  /** The fee as charged, GST included. */
  amount: number
  taxable_value: number
  cgst: number
  sgst: number
  igst: number
}

export class CreditNoteError extends Error {}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** A moment as an ISO time in India: 2026-10-21T15:58:00+05:30. */
export function istIso(at: Date): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS)
  return `${shifted.toISOString().slice(0, 19)}+05:30`
}

/** The GSTR-1 month a moment falls in, in India: 2026-10. */
export function gstr1Period(at: Date): string {
  return istIso(at).slice(0, 7)
}

type LineTotals = { net: number; taxable: number; cgst: number; sgst: number; igst: number }

/** What reversing `quantity` of an invoice line takes back, given what earlier notes already took. */
function reverseLine(
  invoice: LineTotals,
  ordered: number,
  priorQuantity: number,
  prior: LineTotals,
  quantity: number,
  rate: number,
  interState: boolean
): LineTotals {
  const remaining = ordered - priorQuantity
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > remaining) {
    throw new CreditNoteError(`Only ${remaining} unit(s) of this line are left to credit`)
  }
  if (quantity === remaining) {
    // The last of the line takes the rest, so the notes add up to the invoice exactly.
    return {
      net: invoice.net - prior.net,
      taxable: invoice.taxable - prior.taxable,
      cgst: invoice.cgst - prior.cgst,
      sgst: invoice.sgst - prior.sgst,
      igst: invoice.igst - prior.igst,
    }
  }
  const net = Math.round((invoice.net * quantity) / ordered)
  const { gst, base } = extractGstPaise(net, rate)
  const split = splitGstPaise(gst, interState)
  return { net, taxable: base, cgst: split.cgst, sgst: split.sgst, igst: split.igst }
}

export function buildCreditNoteDocument(input: CreditNoteInput): CreditNoteDocument {
  const { order, seller, buyer } = input
  const inter = isInterState(buyer.state, seller.state)

  const amounts = productLineAmounts(
    order.lines.map((line) => ({ id: line.item_id, unit_price: line.unit_price, quantity: line.quantity })),
    order.discount_total,
    input.goods.rate,
    inter
  )

  const lineItems: CreditNoteLine[] = []

  for (const wanted of input.returned) {
    const index = order.lines.findIndex((line) => line.item_id === wanted.item_id)
    if (index === -1) throw new CreditNoteError(`Item ${wanted.item_id} is not on the invoice`)
    const line = order.lines[index]
    const invoice = amounts[index]
    if (invoice.net === 0) continue // the free tote: nothing to reverse

    const priors = input.prior.filter((credit) => credit.item_id === line.item_id)
    const priorTotals: LineTotals = {
      net: priors.reduce((sum, p) => sum + p.net_paise, 0),
      taxable: priors.reduce((sum, p) => sum + p.taxable_paise, 0),
      cgst: priors.reduce((sum, p) => sum + p.cgst_paise, 0),
      sgst: priors.reduce((sum, p) => sum + p.sgst_paise, 0),
      igst: priors.reduce((sum, p) => sum + p.igst_paise, 0),
    }
    const reversed = reverseLine(
      {
        net: toPaise(invoice.net),
        taxable: toPaise(invoice.base),
        cgst: toPaise(invoice.cgst),
        sgst: toPaise(invoice.sgst),
        igst: toPaise(invoice.igst),
      },
      line.quantity,
      priors.reduce((sum, p) => sum + p.quantity, 0),
      priorTotals,
      wanted.quantity,
      input.goods.rate,
      inter
    )

    const variant = (line.variant_title ?? "").trim()
    lineItems.push({
      item_id: line.item_id,
      hsn_sac: input.goods.hsn,
      description:
        !variant || /^default( title| variant)?$/i.test(variant) || variant === line.title ? line.title : `${line.title} (${variant})`,
      quantity: wanted.quantity,
      taxable_value: fromPaise(reversed.taxable),
      gst_rate: input.goods.rate,
      cgst: fromPaise(reversed.cgst),
      sgst: fromPaise(reversed.sgst),
      igst: fromPaise(reversed.igst),
      total: fromPaise(reversed.net),
    })
  }

  if (input.reverse_cod && order.cod_charge > 0) {
    const already = input.prior.some((credit) => credit.item_id === COD_ITEM_ID)
    if (!already) {
      const cod = inclusiveChargeAmounts(order.cod_charge, input.service.rate, inter)
      lineItems.push({
        item_id: COD_ITEM_ID,
        hsn_sac: input.service.sac,
        description: "Cash on Delivery charge",
        quantity: 1,
        taxable_value: cod.base,
        gst_rate: input.service.rate,
        cgst: cod.cgst,
        sgst: cod.sgst,
        igst: cod.igst,
        total: cod.amount,
      })
    }
  }

  if (!lineItems.length) throw new CreditNoteError("There is nothing on this credit note")

  const sum = (pick: (line: CreditNoteLine) => number) =>
    fromPaise(lineItems.reduce((total, line) => total + toPaise(pick(line)), 0))
  const taxable = sum((line) => line.taxable_value)
  const cgst = sum((line) => line.cgst)
  const sgst = sum((line) => line.sgst)
  const igst = sum((line) => line.igst)
  const total = sum((line) => line.total)

  const deduction = fromPaise(Math.min(Math.max(toPaise(input.deduction), 0), toPaise(total)))
  const net = fromPaise(toPaise(total) - toPaise(deduction))
  // A cancelled or refused order that was never paid for (Cash on Delivery) still
  // reverses the invoice, but there is no money to give back.
  const credit_method =
    input.kind === "return"
      ? "store_credit"
      : input.kind === "exchange"
        ? "exchange_adjustment"
        : input.order.nothing_paid
          ? "none"
          : "refund"

  let fee: FeeTax | null = null
  if (deduction > 0 && input.kind !== "cancellation" && input.kind !== "exchange") {
    const charge = inclusiveChargeAmounts(deduction, input.service.rate, inter)
    fee = {
      type: "reverse_logistics",
      description: "Reverse logistics fee",
      sac: input.service.sac,
      gst_rate: input.service.rate,
      amount: charge.amount,
      taxable_value: charge.base,
      cgst: charge.cgst,
      sgst: charge.sgst,
      igst: charge.igst,
    }
  }

  const buyerCode = gstStateCode(buyer.state)
  const sellerCode = gstStateCode(seller.state)
  return {
    credit_note_number: null,
    credit_note_date: null,
    original_invoice_number: input.invoice.number,
    original_invoice_date: istIso(input.invoice.issued_at),
    kind: input.kind,
    reason: input.reason,
    order: { id: order.id, display_id: order.display_id },
    seller: {
      legal_name: seller.legalName,
      gstin: seller.gstin,
      address: [
        [seller.addressLine1, seller.addressLine2].filter(Boolean).join(", "),
        `${seller.city}, ${seller.state} ${seller.pincode}`,
      ],
      state: seller.state,
      state_code: sellerCode,
    },
    customer_details: { name: buyer.name, gstin: buyer.gstin, state: buyer.state, state_code: buyerCode },
    place_of_supply: { state: buyer.state, state_code: buyerCode, tax_type: inter ? "IGST" : "CGST+SGST" },
    line_items: lineItems,
    totals: { taxable_value: taxable, cgst, sgst, igst, total_tax: fromPaise(toPaise(cgst) + toPaise(sgst) + toPaise(igst)), total },
    adjustments: {
      reverse_logistics_fee_deduction: deduction,
      net_store_credit_issued: credit_method === "store_credit" ? net : 0,
      net_refund_amount: credit_method === "refund" ? net : 0,
      credit_method,
      fee,
    },
    currency: "INR",
  }
}

/** The line id used for the Cash on Delivery charge on credit notes. */
export const COD_ITEM_ID = "cod_charge"
