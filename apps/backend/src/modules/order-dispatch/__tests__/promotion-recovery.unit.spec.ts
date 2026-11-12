import { orphanUseWasCounted } from "../promotion-recovery"

describe("orphanUseWasCounted", () => {
  it("gives a use back only when the counter is above the real orders' uses", () => {
    // WELCOME200, once per customer: counted for the leftover, no real order yet.
    expect(orphanUseWasCounted({ kind: "count", registered: 1, expected: 0 })).toBe(true)
    // Counted for a real order only: nothing to give back.
    expect(orphanUseWasCounted({ kind: "count", registered: 1, expected: 1 })).toBe(false)
    // Never counted (the crash came before Medusa counted it).
    expect(orphanUseWasCounted({ kind: "count", registered: 0, expected: 0 })).toBe(false)
    // A real completion counted between the two reads: decline, never over-revert.
    expect(orphanUseWasCounted({ kind: "count", registered: 1, expected: 2 })).toBe(false)
  })

  it("for a spend budget, needs the whole leftover amount to be in the counter", () => {
    expect(orphanUseWasCounted({ kind: "spend", registered: 400, expected: 200, orphan_amount: 200 })).toBe(true)
    expect(orphanUseWasCounted({ kind: "spend", registered: 300, expected: 200, orphan_amount: 200 })).toBe(false)
    expect(orphanUseWasCounted({ kind: "spend", registered: 200, expected: 200, orphan_amount: 0 })).toBe(false)
  })

  it("does nothing for a code with no limit at all", () => {
    expect(orphanUseWasCounted({ kind: "none" })).toBe(false)
  })
})
