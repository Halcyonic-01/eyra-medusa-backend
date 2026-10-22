import {
  DISCOUNT_CODES,
  TOTE_SKU,
  isToteLine,
  qualifiesForTote,
  cartViolations,
  checkDiscountEligibility,
  eligibleCodes,
  findDiscountCode,
  merchandiseSubtotal,
  paymentModeFor,
} from "../commerce-rules"

const line = (unit_price: number, quantity = 1) => ({ unit_price, quantity })

const eligible = (code: string, subtotal: number) => {
  const entry = findDiscountCode(code)!
  return checkDiscountEligibility(entry, subtotal).ok
}

describe("merchandiseSubtotal", () => {
  it("adds price times quantity for every line", () => {
    expect(merchandiseSubtotal([line(2000), line(1500, 2)])).toBe(5000)
  })

  it("reads Medusa BigNumber amounts", () => {
    const big = (n: number) => ({ numeric_: n, raw_: { value: String(n), precision: 20 }, bignumber_: {}, numeric: n })
    expect(merchandiseSubtotal([{ unit_price: big(2000), quantity: big(1) }, { unit_price: big(450), quantity: 2 }])).toBe(2900)
  })

  it("tolerates string or object amounts", () => {
    expect(merchandiseSubtotal([{ unit_price: "1200", quantity: 1 }, { unit_price: { value: "300" }, quantity: 2 }])).toBe(1800)
  })

  it("prices the pair at the pair variant, not at two singles", () => {
    expect(merchandiseSubtotal([line(3800)])).toBe(3800)
    expect(merchandiseSubtotal([line(2850), line(2000)])).toBe(4850)
  })
})

describe("pair price rule (1.9 x single)", () => {
  it.each([
    [2000, 3800],
    [1500, 2850],
  ])("single %i gives pair %i", (single, pair) => {
    expect(Math.round(single * 1.9)).toBe(pair)
  })
})

describe("WELCOME200 (above 1499, no upper limit)", () => {
  it.each([
    [1498, false],
    [1499, false],
    [1499.01, true],
    [1500, true],
    [2999, true],
    [3000, true],
    [3001, true],
    [5001, true],
    [20000, true],
  ])("subtotal %f -> %s", (subtotal, ok) => {
    expect(eligible("WELCOME200", subtotal)).toBe(ok)
  })
})

describe("EYRA350 (above 3000, no upper limit)", () => {
  it.each([
    [1500, false],
    [2999, false],
    [3000, false],
    [3000.01, true],
    [3001, true],
    [5000, true],
    [5001, true],
    [20000, true],
  ])("subtotal %f -> %s", (subtotal, ok) => {
    expect(eligible("EYRA350", subtotal)).toBe(ok)
  })
})

describe("EYRA650 (above 5000, no upper limit)", () => {
  it.each([
    [3001, false],
    [4999, false],
    [5000, false],
    [5000.01, true],
    [5001, true],
    [20000, true],
  ])("subtotal %f -> %s", (subtotal, ok) => {
    expect(eligible("EYRA650", subtotal)).toBe(ok)
  })
})

describe("each code is judged on its own minimum", () => {
  const codesAt = (subtotal: number) => eligibleCodes(subtotal).map((entry) => entry.code)

  it("lists every code that fits, not just one", () => {
    expect(codesAt(1499)).toEqual([])
    expect(codesAt(1500)).toEqual(["WELCOME200"])
    expect(codesAt(3000)).toEqual(["WELCOME200"])
    expect(codesAt(3001)).toEqual(["WELCOME200", "EYRA350"])
    expect(codesAt(5000)).toEqual(["WELCOME200", "EYRA350"])
    expect(codesAt(5001)).toEqual(["WELCOME200", "EYRA350", "EYRA650"])
  })

  it("never refuses a bigger order for being too big", () => {
    for (const entry of DISCOUNT_CODES) {
      for (const subtotal of [10000, 100000, 1000000]) {
        expect(checkDiscountEligibility(entry, subtotal).ok).toBe(true)
      }
    }
  })

  it("only ever explains a refusal as a minimum", () => {
    const verdict = checkDiscountEligibility(findDiscountCode("EYRA350")!, 3000)
    expect(verdict).toEqual({ ok: false, reason: "below_minimum", message: "EYRA350 needs an order above ₹3,000." })
  })

  it("is not moved by the discount itself", () => {
    // 3,100 with EYRA350 still pays 2,750, but the order is judged on the 3,100 of items.
    const subtotal = merchandiseSubtotal([line(3100)])
    expect(codesAt(subtotal)).toContain("EYRA350")
    expect(codesAt(subtotal - 350)).not.toContain("EYRA350")
  })
})

describe("findDiscountCode", () => {
  it("is case and space tolerant and rejects retired codes", () => {
    expect(findDiscountCode(" eyra350 ")?.code).toBe("EYRA350")
    expect(findDiscountCode("WELCOME10")).toBeNull()
    expect(findDiscountCode("LAUNCH20")).toBeNull()
    expect(findDiscountCode("FREESHIP")).toBeNull()
  })

  it("marks only WELCOME200 as once per customer", () => {
    expect(DISCOUNT_CODES.filter((entry) => entry.oncePerCustomer).map((entry) => entry.code)).toEqual(["WELCOME200"])
  })
})

describe("paymentModeFor", () => {
  it("treats Razorpay as prepaid and system default as COD while money is due", () => {
    expect(paymentModeFor(["pp_razorpay_razorpay"], 500)).toBe("prepaid")
    expect(paymentModeFor(["pp_system_default"], 500)).toBe("cod")
    expect(paymentModeFor(["pp_system_default"], 0)).toBe("prepaid")
    expect(paymentModeFor([], 500)).toBeNull()
  })
})

const item = (id: string, unit_price: number, quantity = 1) => ({ id, variant_id: `variant_${id}`, unit_price, quantity })

describe("cartViolations", () => {
  const base = {
    lines: [item("a", 2000)],
    shippingOptionCodes: ["eyra-prepaid"],
    paymentProviderIds: ["pp_razorpay_razorpay"],
    amountDue: 2000,
    promoCodes: [] as string[],
  }

  it("accepts a consistent prepaid order", () => {
    expect(cartViolations(base)).toEqual([])
  })

  it("rejects stacked codes and codes below their minimum", () => {
    expect(cartViolations({ ...base, promoCodes: ["WELCOME200", "EYRA350"] }).length).toBeGreaterThan(0)
    expect(cartViolations({ ...base, promoCodes: ["EYRA350"] })).toHaveLength(1)
    expect(cartViolations({ ...base, promoCodes: ["WELCOME200"] })).toEqual([])
  })

  it("accepts any one code on an order that is above its minimum, however large", () => {
    const big = { ...base, lines: [item("a", 6000)], amountDue: 6000 }
    for (const code of ["WELCOME200", "EYRA350", "EYRA650"]) {
      expect(cartViolations({ ...big, promoCodes: [code] })).toEqual([])
    }
  })

  it("refuses two codes on a large order that fits both", () => {
    const big = { ...base, lines: [item("a", 6000)], amountDue: 6000 }
    expect(cartViolations({ ...big, promoCodes: ["EYRA350", "EYRA650"] })).toEqual([
      "Only one discount code can be used on an order.",
    ])
  })

  it("keeps the COD charge and prepaid shipping tied to the payment method", () => {
    const cod = { ...base, paymentProviderIds: ["pp_system_default"] }
    expect(cartViolations(cod)).toHaveLength(1)
    expect(cartViolations({ ...cod, shippingOptionCodes: ["eyra-cod"] })).toEqual([])
    expect(cartViolations({ ...base, shippingOptionCodes: ["eyra-cod"] })).toHaveLength(1)
    expect(cartViolations({ ...base, shippingOptionCodes: [] })).toHaveLength(1)
    expect(cartViolations({ ...base, shippingOptionCodes: ["eyra-prepaid", "eyra-cod"] })).toHaveLength(1)
    expect(cartViolations({ ...base, shippingOptionCodes: ["standard"] })).toHaveLength(1)
  })

  it("lets a wallet-covered COD cart ship as prepaid", () => {
    const walletOnly = { ...base, paymentProviderIds: ["pp_system_default"], amountDue: 0 }
    expect(cartViolations(walletOnly)).toEqual([])
    expect(cartViolations({ ...walletOnly, shippingOptionCodes: ["eyra-cod"] })).toHaveLength(1)
  })
})

describe("complimentary tote (strictly above 1,499)", () => {
  it.each([
    [1498, false],
    [1499, false],
    [1500, true],
    [3000, true],
  ])("items worth %i -> %s", (subtotal, ok) => {
    expect(qualifiesForTote(subtotal)).toBe(ok)
  })

  const tote = { unit_price: 0, quantity: 1, variant_sku: TOTE_SKU }
  const base = { shippingOptionCodes: ["eyra-prepaid"], paymentProviderIds: ["pp_razorpay_razorpay"], amountDue: 0, promoCodes: [] }

  it("is recognised by its SKU", () => {
    expect(isToteLine(tote)).toBe(true)
    expect(isToteLine({ variant_sku: "RING-1" })).toBe(false)
  })

  it("is never counted in what the customer is buying", () => {
    expect(merchandiseSubtotal([line(1000), tote])).toBe(1000)
  })

  it("one tote on a qualifying order is fine; none is fine too (out of stock)", () => {
    expect(cartViolations({ ...base, lines: [line(1500), tote] })).toEqual([])
    expect(cartViolations({ ...base, lines: [line(1500)] })).toEqual([])
  })

  it("a tote on an order of 1,499 or less is refused", () => {
    expect(cartViolations({ ...base, lines: [line(1499), tote] })).toEqual([
      "The complimentary tote bag is for orders above ₹1,499.",
    ])
  })

  it("two totes are refused", () => {
    expect(cartViolations({ ...base, lines: [line(3000), { ...tote, quantity: 2 }] })).toEqual([
      "Only one complimentary tote bag can be added to an order.",
    ])
  })
})
