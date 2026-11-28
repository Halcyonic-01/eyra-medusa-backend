import { consentCovers, consentOf } from "../analytics-consent"

const at = (iso: string) => new Date(iso)
const record = (status: string, iso: string, version = 1) => ({ analytics_consent: { status, at: iso, version } })

describe("analytics consent", () => {
  it("reads only a well-formed, current-version choice", () => {
    expect(consentOf(record("granted", "2026-11-01T10:00:00.000Z"))).toEqual({ status: "granted", at: at("2026-11-01T10:00:00.000Z"), version: 1 })
    expect(consentOf(null)).toBeNull()
    expect(consentOf({})).toBeNull()
    expect(consentOf(record("yes", "2026-11-01T10:00:00.000Z"))).toBeNull()
    expect(consentOf(record("granted", "not a date"))).toBeNull()
    expect(consentOf(record("granted", "2026-11-01T10:00:00.000Z", 0))).toBeNull()
  })

  it("covers an event only when granted, and granted before it happened", () => {
    const order = at("2026-11-10T12:00:00.000Z")
    expect(consentCovers(consentOf(record("granted", "2026-11-01T10:00:00.000Z")), order)).toBe(true)
    // missing
    expect(consentCovers(null, order)).toBe(false)
    // declined, or withdrawn since (the record holds the latest choice)
    expect(consentCovers(consentOf(record("denied", "2026-11-01T10:00:00.000Z")), order)).toBe(false)
    expect(consentCovers(consentOf(record("denied", "2026-11-20T10:00:00.000Z")), order)).toBe(false)
    // given after the order: not retroactive
    expect(consentCovers(consentOf(record("granted", "2026-11-11T10:00:00.000Z")), order)).toBe(false)
  })
})
