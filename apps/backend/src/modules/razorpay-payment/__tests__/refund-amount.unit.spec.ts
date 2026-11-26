import { refundAmount } from "../service"

describe("Razorpay refund amount", () => {
  it("reads every shape Medusa passes, including the raw form the plugin read as NaN", () => {
    expect(refundAmount(4999)).toBe(4999)
    expect(refundAmount("4999.50")).toBe(4999.5)
    expect(refundAmount({ value: "4999", precision: 20 })).toBe(4999)
    expect(Number.parseFloat(({ value: "4999", precision: 20 }).toString())).toBeNaN()
  })
})
