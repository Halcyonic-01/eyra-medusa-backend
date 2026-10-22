import { planIsEmpty, planPromotionRuleSync } from "../promotion-rules"

const min = (operator: "gt" | "gte", value: string) => ({ attribute: "item_subtotal", operator, values: [value] })
const rule = (id: string, operator: string, value: string, attribute = "item_subtotal") => ({
  id,
  attribute,
  operator,
  values: [{ value }],
})

describe("planPromotionRuleSync", () => {
  it("does nothing when the rules are already right", () => {
    const plan = planPromotionRuleSync([min("gt", "3000")], [rule("r1", "gt", "3000")])
    expect(planIsEmpty(plan)).toBe(true)
  })

  it("removes an old upper limit and keeps the minimum", () => {
    const plan = planPromotionRuleSync([min("gt", "1499")], [rule("r1", "gt", "1499"), rule("r2", "lt", "3000")])
    expect(plan).toEqual({ remove: ["r2"], update: [], add: [] })
  })

  it("makes a minimum that was inclusive strict, as EYRA350 now is", () => {
    const plan = planPromotionRuleSync([min("gt", "3000")], [rule("r1", "gte", "3000"), rule("r2", "lte", "5000")])
    expect(plan).toEqual({ remove: ["r2"], update: [{ id: "r1", operator: "gt", values: ["3000"] }], add: [] })
  })

  it("changes the amount of a minimum", () => {
    const plan = planPromotionRuleSync([min("gt", "5000")], [rule("r1", "gt", "4000")])
    expect(plan).toEqual({ remove: [], update: [{ id: "r1", operator: "gt", values: ["5000"] }], add: [] })
  })

  it("adds the minimum when it is missing", () => {
    const plan = planPromotionRuleSync([min("gt", "1499")], [])
    expect(plan).toEqual({ remove: [], update: [], add: [min("gt", "1499")] })
  })

  it("treats 3000 and 3000.00 as the same amount", () => {
    expect(planIsEmpty(planPromotionRuleSync([min("gt", "3000")], [rule("r1", "gt", "3000.00")]))).toBe(true)
  })

  it("leaves rules on other attributes alone", () => {
    const plan = planPromotionRuleSync([min("gt", "1499")], [rule("r1", "gt", "1499"), rule("r9", "in", "x", "customer_group")])
    expect(planIsEmpty(plan)).toBe(true)
  })
})
