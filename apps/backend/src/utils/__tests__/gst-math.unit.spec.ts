import {
  allocateProportionally,
  extractGstPaise,
  inclusiveChargeAmounts,
  productLineAmounts,
  splitGstPaise,
  toPaise,
} from "../gst-math"

// The storefront (lib/gst.ts) works the same sums, and its tests use these same
// examples, so an invoice and the credit note that reverses it agree to the paisa.

describe("taking GST out of an inclusive amount", () => {
  it("uses amount x rate / (100 + rate): 3,450 at 3% is 100.49", () => {
    expect(extractGstPaise(345000, 3)).toEqual({ gst: 10049, base: 334951 })
  })

  it("base plus GST is the amount for every price", () => {
    const bad: number[] = []
    for (let paise = 0; paise <= 2_000_000; paise += 37) {
      for (const rate of [3, 18]) {
        const { gst, base } = extractGstPaise(paise, rate)
        if (gst + base !== paise) bad.push(paise)
      }
    }
    expect(bad).toEqual([])
  })
})

describe("worked examples", () => {
  it("a 1,499 ring: 1,455.34 taxable, 21.83 CGST, 21.83 SGST", () => {
    const [line] = productLineAmounts([{ id: "a", unit_price: 1499, quantity: 1 }], 0, 3, false)
    expect(line).toMatchObject({ net: 1499, base: 1455.34, gst: 43.66, cgst: 21.83, sgst: 21.83 })
  })

  it("the 99 Cash on Delivery charge at 18%: 83.90 + 15.10", () => {
    expect(inclusiveChargeAmounts(99, 18, true)).toEqual({ amount: 99, base: 83.9, gst: 15.1, cgst: 0, sgst: 0, igst: 15.1 })
    expect(inclusiveChargeAmounts(99, 18, false)).toMatchObject({ cgst: 7.55, sgst: 7.55, igst: 0 })
  })

  it("an odd paisa of GST goes to CGST, so the halves add up", () => {
    expect(splitGstPaise(4349, false)).toEqual({ cgst: 2175, sgst: 2174, igst: 0 })
    expect(splitGstPaise(4349, true)).toEqual({ cgst: 0, sgst: 0, igst: 4349 })
  })
})

describe("spreading a discount over lines", () => {
  it("shares add up to the discount, to the paisa", () => {
    const bad: string[] = []
    for (const total of [1, 99, 20000, 35000, 65000, 12345]) {
      for (const weights of [[1], [1, 1], [1, 1, 1], [200000, 100000], [149900, 150000, 1], [333, 333, 334]]) {
        const sum = allocateProportionally(total, weights).reduce((a, b) => a + b, 0)
        if (sum !== total) bad.push(`${total} over ${weights}`)
      }
    }
    expect(bad).toEqual([])
  })

  it("is proportional, the odd paisa going to the largest remainder", () => {
    expect(allocateProportionally(35000, [200000, 100000])).toEqual([23333, 11667])
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33])
  })

  it("two lines, 350 off 3,000: 233.33 and 116.67, tax per line, net 2,650", () => {
    const lines = productLineAmounts(
      [
        { id: "ring", unit_price: 2000, quantity: 1 },
        { id: "chain", unit_price: 1000, quantity: 1 },
      ],
      350,
      3,
      false
    )
    expect(lines.map((l) => [l.discount, l.net])).toEqual([
      [233.33, 1766.67],
      [116.67, 883.33],
    ])
    const gst = lines.reduce((sum, l) => sum + toPaise(l.gst), 0)
    const base = lines.reduce((sum, l) => sum + toPaise(l.base), 0)
    expect(gst).toBe(7719)
    expect(base + gst).toBe(265000)
  })

  it("a free line takes no discount and has no tax", () => {
    const lines = productLineAmounts(
      [
        { id: "ring", unit_price: 2000, quantity: 1 },
        { id: "tote", unit_price: 0, quantity: 1 },
      ],
      200,
      3,
      true
    )
    expect(lines[1]).toMatchObject({ gross: 0, discount: 0, net: 0, base: 0, gst: 0 })
  })
})
