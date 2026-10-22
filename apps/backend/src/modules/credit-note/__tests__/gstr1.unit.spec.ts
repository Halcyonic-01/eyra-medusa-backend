import { previousMonth } from "../../../jobs/export-gstr1-credit-notes"
import { buildCreditNoteDocument } from "../document"
import { GSTR1_COLUMNS, gstr1Csv } from "../gstr1"

const seller = {
  legalName: "EYRA JEWELS PRIVATE LIMITED", gstin: "20AAJCE7349A1Z1", addressLine1: "Ward 12", addressLine2: "",
  city: "Garhwa", state: "Jharkhand", pincode: "822114",
}

const note = (name: string, buyerState = "Karnataka") => {
  const document = buildCreditNoteDocument({
    kind: "return",
    reason: "SIZE_ISSUE",
    order: {
      id: "order_1", display_id: 5, discount_total: 0, cod_charge: 99,
      lines: [{ item_id: "i1", title: 'Ring, "Rose"', variant_title: null, quantity: 1, unit_price: 1499 }],
    },
    buyer: { name, state: buyerState, gstin: null },
    seller,
    invoice: { number: "EYRA/26-27/01089", issued_at: new Date("2026-10-15T05:00:00Z") },
    goods: { rate: 3, hsn: "7113" },
    service: { rate: 18, sac: "9997" },
    returned: [{ item_id: "i1", quantity: 1 }],
    reverse_cod: true,
    deduction: 99,
    prior: [],
    return_request_id: null,
  })
  return { payload: { ...document, credit_note_number: "CN/26-27/0042", credit_note_date: "2026-10-21T15:58:00+05:30" } }
}

describe("GSTR-1 credit note feed", () => {
  it("has a header and one row per credit note line", () => {
    const rows = gstr1Csv([note("Jane Doe")]).trim().split("\r\n")
    expect(rows[0]).toBe(GSTR1_COLUMNS.map((c) => `"${c}"`).join(","))
    expect(rows).toHaveLength(4) // header, the ring, the COD charge, the fee kept
  })

  it("carries the seller GSTIN, note and invoice numbers, HSN/SAC, taxable value and the three taxes", () => {
    const [, ring, cod, fee] = gstr1Csv([note("Jane Doe")]).trim().split("\r\n")
    expect(ring).toBe(
      '"20AAJCE7349A1Z1","","Jane Doe","29","CN/26-27/0042","2026-10-21","EYRA/26-27/01089","2026-10-15","7113","Ring, ""Rose""",1,3.00,1455.34,0.00,0.00,43.66,1499.00,"Credit note line"'
    )
    expect(cod).toContain('"9997","Cash on Delivery charge",1,18.00,83.90,0.00,0.00,15.10,99.00,"Credit note line"')
    // The 99 kept is a service with its own 18% GST: 83.90 + 15.10.
    expect(fee).toContain('"9997","Reverse logistics fee",1,18.00,83.90,0.00,0.00,15.10,99.00,"Fee retained"')
  })

  it("splits CGST and SGST inside the seller's state", () => {
    const [, ring] = gstr1Csv([note("Jane Doe", "Jharkhand")]).trim().split("\r\n")
    expect(ring).toContain(",1455.34,21.83,21.83,0.00,1499.00")
    // Inside the state the fee's GST splits too: 7.55 and 7.55.
    expect(gstr1Csv([note("Jane Doe", "Jharkhand")]).trim().split("\r\n")[3]).toContain(",83.90,7.55,7.55,0.00,99.00,")
  })

  it("defuses a name that a spreadsheet would run as a formula", () => {
    const [, ring] = gstr1Csv([note("=HYPERLINK(\"http://x\")")]).trim().split("\r\n")
    expect(ring).toContain(`"'=HYPERLINK(""http://x"")"`)
  })

  it("is only the header for a month with no notes", () => {
    expect(gstr1Csv([]).trim().split("\r\n")).toHaveLength(1)
  })
})

describe("previous month", () => {
  it("is last month in India", () => {
    expect(previousMonth(new Date("2026-11-01T01:00:00Z"))).toBe("2026-10")
    expect(previousMonth(new Date("2027-01-01T01:00:00Z"))).toBe("2026-12")
    // 19:00 UTC on 31 Oct is already 1 Nov in India.
    expect(previousMonth(new Date("2026-10-31T19:00:00Z"))).toBe("2026-10")
  })
})
