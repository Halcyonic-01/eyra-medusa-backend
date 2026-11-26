import { attemptDue, recheckMinutes } from "../current-attempts"

const now = new Date("2026-11-26T10:00:00Z")
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000)

describe("missed-payment sweep cadence", () => {
  it("asks fresh attempts often and old ones rarely", () => {
    expect(recheckMinutes(10)).toBe(5)
    expect(recheckMinutes(120)).toBe(30)
    expect(recheckMinutes(24 * 60)).toBe(180)
  })
  it("a never-asked attempt is always due; an old one only after its backoff", () => {
    expect(attemptDue({ created_at: ago(600), reconciled_at: null }, now)).toBe(true)
    expect(attemptDue({ created_at: ago(20), reconciled_at: ago(4) }, now)).toBe(false)
    expect(attemptDue({ created_at: ago(20), reconciled_at: ago(6) }, now)).toBe(true)
    expect(attemptDue({ created_at: ago(600), reconciled_at: ago(60) }, now)).toBe(false)
    expect(attemptDue({ created_at: ago(600), reconciled_at: ago(181) }, now)).toBe(true)
  })
})
