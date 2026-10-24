import { jwtExpiry } from "../jwt-expiry"

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = (exp: number) => `${part({ alg: "HS256" })}.${part({ exp })}.signature`

describe("jwtExpiry", () => {
  it("reads the expiry from the payload", () => {
    expect(jwtExpiry(token(1792000000))?.toISOString()).toBe(new Date(1792000000 * 1000).toISOString())
  })

  it("is null for anything that is not a JWT with an expiry", () => {
    expect(jwtExpiry(undefined)).toBeNull()
    expect(jwtExpiry("")).toBeNull()
    expect(jwtExpiry("plain-secret-value")).toBeNull()
    expect(jwtExpiry(`${part({})}.${part({ sub: "x" })}.s`)).toBeNull()
  })
})
