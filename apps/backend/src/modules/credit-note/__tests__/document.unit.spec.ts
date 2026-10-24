import {
  COD_ITEM_ID,
  CreditNoteError,
  buildCreditNoteDocument,
  gstr1Period,
  istIso,
  type CreditNoteInput,
  type PriorCredit,
} from "../document"

const seller = {
  legalName: "EYRA JEWELS PRIVATE LIMITED",
  gstin: "20AAJCE7349A1Z1",
  addressLine1: "Ward No. 12, Main Road",
  addressLine2: "",
  city: "Garhwa",
  state: "Jharkhand",
  pincode: "822114",
}

const input = (overrides: Partial<CreditNoteInput> = {}): CreditNoteInput => ({
  kind: "return",
  reason: "SIZE_ISSUE",
  order: {
    id: "order_1",
    display_id: 1089,
    discount_total: 0,
    cod_charge: 0,
    lines: [{ item_id: "i1", title: "Sterling Silver Ring", variant_title: "Size 12", quantity: 1, unit_price: 1499 }],
  },
  buyer: { name: "Jane Doe", state: "Jharkhand", gstin: null },
  seller,
  invoice: { number: "EYRA/26-27/01089", issued_at: new Date("2026-10-15T05:00:00Z") },
  goods: { rate: 3, hsn: "7113" },
  service: { rate: 18, sac: "9997" },
  returned: [{ item_id: "i1", quantity: 1 }],
  reverse_cod: false,
  deduction: 99,
  prior: [],
  return_request_id: "retreq_1",
  ...overrides,
})

const paise = (rupees: number) => Math.round(rupees * 100)

/** What a credit note took off one line, as a PriorCredit for the next note. */
const asPrior = (doc: ReturnType<typeof buildCreditNoteDocument>): PriorCredit[] =>
  doc.line_items.map((line) => ({
    item_id: line.item_id,
    quantity: line.quantity,
    net_paise: paise(line.total),
    taxable_paise: paise(line.taxable_value),
    cgst_paise: paise(line.cgst),
    sgst_paise: paise(line.sgst),
    igst_paise: paise(line.igst),
  }))

describe("the example in the rules", () => {
  it("a 1,499 ring returned: 1,455.34 + 21.83 + 21.83 = 1,499, 99 kept, 1,400 credit", () => {
    const doc = buildCreditNoteDocument(input())
    expect(doc.line_items).toEqual([
      {
        item_id: "i1",
        hsn_sac: "7113",
        description: "Sterling Silver Ring (Size 12)",
        quantity: 1,
        taxable_value: 1455.34,
        gst_rate: 3,
        cgst: 21.83,
        sgst: 21.83,
        igst: 0,
        total: 1499,
      },
    ])
    expect(doc.adjustments).toMatchObject({
      reverse_logistics_fee_deduction: 99,
      net_store_credit_issued: 1400,
      net_refund_amount: 0,
      credit_method: "store_credit",
    })
    expect(doc.original_invoice_number).toBe("EYRA/26-27/01089")
    expect(doc.original_invoice_date).toBe("2026-10-15T10:30:00+05:30")
    expect(doc.place_of_supply).toEqual({ state: "Jharkhand", state_code: "20", tax_type: "CGST+SGST" })
  })

  it("to another state it is all IGST", () => {
    const doc = buildCreditNoteDocument(input({ buyer: { name: "Jane Doe", state: "Karnataka", gstin: null } }))
    expect(doc.line_items[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 43.66, taxable_value: 1455.34 })
    expect(doc.place_of_supply).toMatchObject({ state_code: "29", tax_type: "IGST" })
    expect(doc.totals).toMatchObject({ igst: 43.66, total_tax: 43.66, total: 1499 })
  })
})

describe("GST on the fees (18%, SAC 9997)", () => {
  it("the 99 kept from a return is 83.90 + 15.10, shown as IGST to another state", () => {
    const doc = buildCreditNoteDocument(input({ buyer: { name: "Jane Doe", state: "Karnataka", gstin: null } }))
    expect(doc.adjustments.fee).toEqual({
      type: "reverse_logistics",
      description: "Reverse logistics fee",
      sac: "9997",
      gst_rate: 18,
      amount: 99,
      taxable_value: 83.9,
      cgst: 0,
      sgst: 0,
      igst: 15.1,
    })
  })

  it("is split 9% and 9% inside the seller's state", () => {
    const doc = buildCreditNoteDocument(input())
    expect(doc.adjustments.fee).toMatchObject({ taxable_value: 83.9, cgst: 7.55, sgst: 7.55, igst: 0 })
  })

  it("the fee is still taken out of the credit as before: 1,499 less 99 is 1,400", () => {
    expect(buildCreditNoteDocument(input()).adjustments.net_store_credit_issued).toBe(1400)
  })

  it("no fee, no fee row: a damaged item is credited in full", () => {
    const doc = buildCreditNoteDocument(input({ deduction: 0, reason: "DEFECTIVE" }))
    expect(doc.adjustments.fee).toBeNull()
    expect(doc.adjustments.net_store_credit_issued).toBe(1499)
  })

  it("a fee larger than the credit is capped, and the GST is on what was actually kept", () => {
    const doc = buildCreditNoteDocument(
      input({
        order: { id: "o", display_id: 1, discount_total: 0, cod_charge: 0, lines: [{ item_id: "i1", title: "Chain", variant_title: null, quantity: 1, unit_price: 60 }] },
      })
    )
    expect(doc.adjustments.reverse_logistics_fee_deduction).toBe(60)
    expect(doc.adjustments.fee).toMatchObject({ amount: 60, taxable_value: 50.85, cgst: 4.58, sgst: 4.57 })
  })

  it("an exchange has no fee at all, and credits the whole item against the replacement", () => {
    const doc = buildCreditNoteDocument(input({ kind: "exchange", deduction: 0 }))
    expect(doc.adjustments.fee).toBeNull()
    expect(doc.adjustments.reverse_logistics_fee_deduction).toBe(0)
    expect(doc.adjustments.credit_method).toBe("exchange_adjustment")
  })

  it("a cancellation after dispatch has no fee", () => {
    expect(buildCreditNoteDocument(input({ kind: "cancellation", deduction: 0 })).adjustments.fee).toBeNull()
  })
})

describe("the reverse logistics fee", () => {
  it("is kept back from what the customer gets, never more than the credit", () => {
    const doc = buildCreditNoteDocument(input({ deduction: 5000 }))
    expect(doc.adjustments.reverse_logistics_fee_deduction).toBe(1499)
    expect(doc.adjustments.net_store_credit_issued).toBe(0)
  })

  it("is shown as a refund for a cancellation after dispatch", () => {
    const doc = buildCreditNoteDocument(input({ kind: "cancellation", deduction: 0 }))
    expect(doc.adjustments).toMatchObject({ net_store_credit_issued: 0, net_refund_amount: 1499, credit_method: "refund" })
  })

  it("says nothing is refunded when the order was never paid for (Cash on Delivery)", () => {
    const base = input({ kind: "cancellation", deduction: 0 })
    const doc = buildCreditNoteDocument({ ...base, order: { ...base.order, nothing_paid: true } })
    // The invoice is still reversed in full, but no money goes back.
    expect(doc.totals.total).toBe(1499)
    expect(doc.adjustments).toMatchObject({ net_store_credit_issued: 0, net_refund_amount: 0, credit_method: "none" })
  })

  it("does the same for a refused parcel that was never paid for", () => {
    const base = input({ kind: "rto", deduction: 0 })
    const doc = buildCreditNoteDocument({ ...base, order: { ...base.order, nothing_paid: true } })
    expect(doc.adjustments).toMatchObject({ net_refund_amount: 0, credit_method: "none" })
  })

  it("never changes a return, which is always store credit", () => {
    const base = input({ deduction: 0 })
    const doc = buildCreditNoteDocument({ ...base, order: { ...base.order, nothing_paid: true } })
    expect(doc.adjustments.credit_method).toBe("store_credit")
  })
})

describe("a discount spread over lines is reversed line by line", () => {
  const two = (returned: CreditNoteInput["returned"], extra: Partial<CreditNoteInput> = {}) =>
    input({
      order: {
        id: "order_2",
        display_id: 7,
        discount_total: 350,
        cod_charge: 0,
        lines: [
          { item_id: "ring", title: "Ring", variant_title: null, quantity: 1, unit_price: 2000 },
          { item_id: "chain", title: "Chain", variant_title: null, quantity: 1, unit_price: 1000 },
        ],
      },
      returned,
      deduction: 0,
      ...extra,
    })

  it("returning the chain takes back its own share: 883.33, not 1,000", () => {
    const doc = buildCreditNoteDocument(two([{ item_id: "chain", quantity: 1 }]))
    expect(doc.line_items[0]).toMatchObject({ total: 883.33, taxable_value: 857.6, cgst: 12.87, sgst: 12.86 })
  })

  it("returning both takes back the whole net invoice, 2,650, with the invoice's GST", () => {
    const doc = buildCreditNoteDocument(
      two([
        { item_id: "ring", quantity: 1 },
        { item_id: "chain", quantity: 1 },
      ])
    )
    expect(doc.totals.total).toBe(2650)
    // The same per-line GST the invoice shows: 51.46 + 25.73 = 77.19.
    expect(doc.totals.total_tax).toBe(77.19)
    expect(paise(doc.totals.taxable_value) + paise(doc.totals.total_tax)).toBe(265000)
  })
})

describe("a line returned in parts adds up to the invoice line, to the paisa", () => {
  const triple: Partial<CreditNoteInput> = {
    order: {
      id: "order_3",
      display_id: 8,
      discount_total: 100,
      cod_charge: 0,
      lines: [{ item_id: "x", title: "Anklet", variant_title: "Single", quantity: 3, unit_price: 1000 }],
    },
    deduction: 0,
  }

  it("three notes of one unit each: 966.67, 966.67, 966.66", () => {
    const first = buildCreditNoteDocument(input({ ...triple, returned: [{ item_id: "x", quantity: 1 }] }))
    const second = buildCreditNoteDocument(
      input({ ...triple, returned: [{ item_id: "x", quantity: 1 }], prior: asPrior(first) })
    )
    const third = buildCreditNoteDocument(
      input({ ...triple, returned: [{ item_id: "x", quantity: 1 }], prior: [...asPrior(first), ...asPrior(second)] })
    )
    expect([first, second, third].map((d) => d.totals.total)).toEqual([966.67, 966.67, 966.66])

    const all = buildCreditNoteDocument(input({ ...triple, returned: [{ item_id: "x", quantity: 3 }] }))
    const sum = (pick: (d: typeof first) => number) => [first, second, third].reduce((s, d) => s + paise(pick(d)), 0)
    expect(sum((d) => d.totals.total)).toBe(paise(all.totals.total))
    expect(sum((d) => d.totals.taxable_value)).toBe(paise(all.totals.taxable_value))
    expect(sum((d) => d.totals.cgst)).toBe(paise(all.totals.cgst))
    expect(sum((d) => d.totals.sgst)).toBe(paise(all.totals.sgst))
  })

  it("cannot credit more units than the invoice has left", () => {
    const first = buildCreditNoteDocument(input({ ...triple, returned: [{ item_id: "x", quantity: 2 }] }))
    expect(() =>
      buildCreditNoteDocument(input({ ...triple, returned: [{ item_id: "x", quantity: 2 }], prior: asPrior(first) }))
    ).toThrow(CreditNoteError)
  })

  it("cannot credit a line that is not on the invoice", () => {
    expect(() => buildCreditNoteDocument(input({ returned: [{ item_id: "nope", quantity: 1 }] }))).toThrow(/not on the invoice/)
  })
})

describe("the Cash on Delivery charge", () => {
  const cod = (extra: Partial<CreditNoteInput> = {}) =>
    input({
      order: {
        id: "order_4",
        display_id: 9,
        discount_total: 0,
        cod_charge: 99,
        lines: [{ item_id: "i1", title: "Ring", variant_title: null, quantity: 1, unit_price: 1499 }],
      },
      kind: "cancellation",
      deduction: 0,
      ...extra,
    })

  it("is reversed in full, 83.90 + 15.10 under SAC 9997, when asked", () => {
    const doc = buildCreditNoteDocument(cod({ reverse_cod: true, buyer: { name: "A", state: "Karnataka", gstin: null } }))
    expect(doc.line_items.map((l) => l.item_id)).toEqual(["i1", COD_ITEM_ID])
    expect(doc.line_items[1]).toMatchObject({
      hsn_sac: "9997", taxable_value: 83.9, gst_rate: 18, igst: 15.1, total: 99, description: "Cash on Delivery charge",
    })
    expect(doc.totals.total).toBe(1598)
  })

  it("is split 9% and 9% inside the seller's state", () => {
    const doc = buildCreditNoteDocument(cod({ reverse_cod: true }))
    expect(doc.line_items[1]).toMatchObject({ cgst: 7.55, sgst: 7.55, igst: 0 })
  })

  it("is left alone when not asked (a delivered order keeps the charge)", () => {
    const doc = buildCreditNoteDocument(cod({ reverse_cod: false }))
    expect(doc.line_items.map((l) => l.item_id)).toEqual(["i1"])
    expect(doc.totals.total).toBe(1499)
  })

  it("is reversed once, never twice", () => {
    const first = buildCreditNoteDocument(cod({ reverse_cod: true, returned: [{ item_id: "i1", quantity: 1 }] }))
    const again = () =>
      buildCreditNoteDocument(cod({ reverse_cod: true, returned: [{ item_id: "i1", quantity: 1 }], prior: asPrior(first) }))
    // The product is already credited in full, and the COD charge too: nothing is left.
    expect(again).toThrow(CreditNoteError)
  })

  it("a prepaid order has no charge to reverse", () => {
    const doc = buildCreditNoteDocument(input({ reverse_cod: true }))
    expect(doc.line_items.map((l) => l.item_id)).toEqual(["i1"])
  })
})

describe("the complimentary tote", () => {
  it("has nothing to reverse, and a note of only the tote is refused", () => {
    const withTote = input({
      order: {
        id: "order_5",
        display_id: 10,
        discount_total: 0,
        cod_charge: 0,
        lines: [
          { item_id: "ring", title: "Ring", variant_title: null, quantity: 1, unit_price: 2000 },
          { item_id: "tote", title: "EYRA Tote Bag", variant_title: null, quantity: 1, unit_price: 0 },
        ],
      },
    })
    const both = buildCreditNoteDocument({ ...withTote, returned: [{ item_id: "ring", quantity: 1 }, { item_id: "tote", quantity: 1 }] })
    expect(both.line_items.map((l) => l.item_id)).toEqual(["ring"])
    expect(() => buildCreditNoteDocument({ ...withTote, returned: [{ item_id: "tote", quantity: 1 }] })).toThrow(/nothing/)
  })
})

describe("dates", () => {
  it("are ISO times in India", () => {
    expect(istIso(new Date("2026-10-21T10:28:00Z"))).toBe("2026-10-21T15:58:00+05:30")
  })

  it("the GSTR-1 month follows the Indian date, not UTC", () => {
    expect(gstr1Period(new Date("2026-10-31T19:00:00Z"))).toBe("2026-11")
    expect(gstr1Period(new Date("2026-10-31T17:00:00Z"))).toBe("2026-10")
  })
})
