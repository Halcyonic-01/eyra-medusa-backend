import * as Sentry from "@sentry/node"

// Fake secret-shaped values, built at run time so secret scanners have nothing to match in the source.
const b64url = (text: string) => Buffer.from(text).toString("base64url")
const fakeJwt = (sub: string) => [b64url('{"alg":"HS256"}'), b64url(`{"sub":"${sub}"}`), b64url("not-a-signature")].join(".")
const fakeKey = (prefix: string, rest: string) => [prefix, rest].join("_")
const fakeCard = (separator: string) => ["4111", "1111", "1111", "1111"].join(separator)

jest.mock("@sentry/node", () => ({
  ...jest.requireActual("@sentry/node"),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: (callback: (scope: { setContext: () => void }) => void) => callback({ setContext: () => undefined }),
}))

import { DATA_COLLECTION, isPersonalKey, messageFingerprint, reportingLogger, scrubEvent, scrubSpan, scrubText, scrubUrl, sentryServerConfig } from "../sentry"

describe("Sentry configuration", () => {
  it("is off without a DSN, and names the environment and release from Railway", () => {
    expect(sentryServerConfig({})).toBeNull()
    expect(sentryServerConfig({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/1", RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_GIT_COMMIT_SHA: "abc123" })).toEqual({
      dsn: "https://k@o1.ingest.sentry.io/1",
      environment: "staging",
      release: "abc123",
    })
    expect(sentryServerConfig({ SENTRY_DSN: "x", NODE_ENV: "production" })?.environment).toBe("production")
    expect(sentryServerConfig({ SENTRY_DSN: "x", NODE_ENV: "development" })?.environment).toBe("development")
  })

  it("collects no cookies, bodies, query values, local variables or user details", () => {
    expect(DATA_COLLECTION).toMatchObject({ userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false, databaseQueryData: false })
  })
})

describe("the privacy filter", () => {
  it("removes the request's personal parts, emails and phone numbers", () => {
    const event = {
      type: undefined,
      user: { id: "cus_1", email: "a@b.com" },
      request: {
        url: "https://api.eyra.org.in/store/carts/cart_1?email=a@b.com",
        query_string: "email=a@b.com",
        cookies: { "connect.sid": "s" },
        data: { shipping_address: { phone: "9876543210" } },
        headers: { "user-agent": "UA", authorization: "Bearer x", "x-publishable-api-key": "pk_1" },
      },
      exception: { values: [{ type: "Error", value: "no customer for asha@example.com (+91 9876543210)" }] },
      extra: { body: { email: "a@b.com", cart_id: "cart_1" } },
    } as unknown as Sentry.ErrorEvent
    const out = scrubEvent(event)
    expect(out.user).toBeUndefined()
    expect(out.request).toEqual({ url: "https://api.eyra.org.in/store/carts/cart_1?email=[filtered]", headers: { "user-agent": "UA" } })
    expect(out.exception?.values?.[0].value).toBe("no customer for [email] ([phone])")
    expect(out.extra).toEqual({ body: { email: "[filtered]", cart_id: "cart_1" } })
    expect(scrubUrl("/admin/orders?q=asha")).toBe("/admin/orders?q=[filtered]")
  })

  it("groups log messages that differ only in ids and numbers", () => {
    expect(messageFingerprint("[payment-reconcile] order order_01JABCDEFGHJK not repaired this run: 502")).toBe(
      messageFingerprint("[payment-reconcile] order order_01JZYXWVUTSRQ not repaired this run: 503")
    )
  })
})

describe("the reporting logger", () => {
  const base = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), activity: jest.fn(() => "id"), shouldLog: jest.fn(() => true) }) as any
  const exceptions = Sentry.captureException as jest.Mock
  const messages = Sentry.captureMessage as jest.Mock

  beforeEach(() => jest.clearAllMocks())

  it("logs as before and reports errors: an Error object, an error with a message, or a message", () => {
    const inner = base()
    const logger = reportingLogger(inner)
    const crash = new Error("db down")
    logger.error(crash)
    logger.error("[wallet] could not deduct", crash)
    logger.error("Scheduled job reconcile failed with error: boom")
    expect(inner.error).toHaveBeenCalledTimes(3)
    expect(exceptions).toHaveBeenCalledTimes(2)
    expect(messages).toHaveBeenCalledWith("Scheduled job reconcile failed with error: boom", expect.objectContaining({ level: "error" }))
  })

  it("reports a crashed subscriber, but not ordinary warnings", () => {
    const inner = base()
    const logger = reportingLogger(inner)
    logger.warn("[analytics] PostHog answered 503")
    logger.warn("An error occurred while processing order.placed:")
    logger.warn(new Error("subscriber threw") as any)
    expect(inner.warn).toHaveBeenCalledTimes(3)
    expect(exceptions).toHaveBeenCalledTimes(1)
    expect(messages).not.toHaveBeenCalled()
  })

  it("passes every other method through", () => {
    const inner = base()
    const logger = reportingLogger(inner)
    logger.info("hello")
    expect(logger.activity("x")).toBe("id")
    expect(inner.info).toHaveBeenCalledWith("hello")
  })
})

describe("the privacy filter fails closed", () => {
  const SECRETS = {
    email: "leak.person@example.com",
    phone: "9812345678",
    address: "42 Secret Lane",
    jwt: fakeJwt("user123"),
    bearer: "s3cr3tB3arerT0ken",
    card: fakeCard(" "),
    key: fakeKey("rzp_live", "ABCDEFGH12345"),
    password: "hunter2pass",
    publishable: "pk_0123456789abcdef0123456789abcdef",
  }
  const deep = (levels: number, leaf: unknown): unknown => (levels === 0 ? leaf : { level: deep(levels - 1, leaf) })

  function poisoned(): Sentry.ErrorEvent {
    const cycle: Record<string, unknown> = { note: `cycle ${SECRETS.email}` }
    cycle.self = cycle
    return {
      event_id: "abc123",
      release: "sha1",
      message: `could not reach ${SECRETS.email} at ${SECRETS.phone}`,
      logentry: { message: "%s failed", params: [{ customerEmail: SECRETS.email }, `Bearer ${SECRETS.bearer}`] },
      user: { id: "cus_1", email: SECRETS.email, ip_address: "203.0.113.9" },
      request: {
        method: "POST",
        url: `https://api.eyra.org.in/store/customers/me?phone=${SECRETS.phone}`,
        cookies: { "connect.sid": SECRETS.jwt },
        data: { shippingAddress: { line1: SECRETS.address } },
        env: { REMOTE_ADDR: "203.0.113.9" },
        headers: { "user-agent": "UA", authorization: `Bearer ${SECRETS.bearer}`, "x-publishable-api-key": SECRETS.publishable, "x-forwarded-for": "203.0.113.9" },
        unexpected_field: { contactPhone: SECRETS.phone },
      },
      exception: {
        values: [
          { type: "Error", value: `card ${SECRETS.card} refused for ${SECRETS.email}`, mechanism: { type: "generic", handled: true, data: { phoneNumber: SECRETS.phone } }, stacktrace: { frames: [{ filename: "src/workflows/x.ts", lineno: 3, vars: { password: SECRETS.password, body: SECRETS.address } }] } },
          { type: "Error", value: `cause: token=${SECRETS.password}` },
        ],
      },
      breadcrumbs: [
        { category: "http", data: { url: `https://api.razorpay.com/v1/x?email=${SECRETS.email}`, nested: { deeper: { recipient: SECRETS.email } } } },
        { category: "console", message: `key ${SECRETS.key}`, data: { arguments: [{ shipping_address: { address_1: SECRETS.address } }] } },
      ],
      contexts: {
        trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef", data: { "url.full": `https://x.in/a?email=${SECRETS.email}` } },
        runtime: { name: "node", version: "v22" },
        log: { message: `[email] not sent to ${SECRETS.email}` },
        customer: { note: SECRETS.address },
      },
      tags: { recipient: SECRETS.email },
      extra: { arguments: [deep(12, SECRETS.email)], cycle, order_id: "order_01J", total: 2099 },
      some_future_field: { buyer: { mobileNo: SECRETS.phone, text: `password: ${SECRETS.password}` } },
    } as unknown as Sentry.ErrorEvent
  }

  it("lets no sentinel through, anywhere in the event", () => {
    const sent = JSON.stringify(scrubEvent(poisoned()))
    for (const [what, secret] of Object.entries(SECRETS)) expect([what, sent.includes(secret)]).toEqual([what, false])
    expect(sent).not.toContain("203.0.113.9")
  })

  it("keeps what is needed to debug", () => {
    const out = scrubEvent(poisoned()) as unknown as Record<string, any>
    expect(out.request).toEqual({ method: "POST", url: "https://api.eyra.org.in/store/customers/me?phone=[filtered]", headers: { "user-agent": "UA" } })
    expect(out.exception.values[0].stacktrace.frames).toEqual([{ filename: "src/workflows/x.ts", lineno: 3 }])
    expect(out.contexts.trace).toMatchObject({ trace_id: "0123456789abcdef0123456789abcdef" })
    expect(out.contexts.customer).toBeUndefined()
    expect(out.extra).toMatchObject({ order_id: "order_01J", total: 2099 })
    expect(out.user).toBeUndefined()
  })

  it("recognises personal keys in any casing, and secrets in text", () => {
    for (const key of ["customerEmail", "x-publishable-api-key", "phoneNumber", "shipping_address", "Authorization", "ipAddress"]) expect([key, isPersonalKey(key)]).toEqual([key, true])
    for (const key of ["order_id", "cart_id", "awb", "status", "total", "display_id"]) expect([key, isPersonalKey(key)]).toEqual([key, false])
    expect(scrubText(`pay ${fakeCard("-")}, awb 77665544332211`)).toBe("pay [card], awb 77665544332211")
  })
})

describe("database errors", () => {
  it("lose the values they quote", () => {
    expect(scrubText(`insert into "customer" ("first_name") values ('Asha') - duplicate key`)).toBe(`insert into "customer" ("first_name") values ('[filtered]') - duplicate key`)
    expect(scrubText("Key (email)=(asha@example.com) already exists.")).toBe("Key (email)=([filtered]) already exists.")
  })
})

describe("streamed spans", () => {
  it("lose query values and personal attributes, and keep Sentry's ids", () => {
    const span = {
      name: "GET /store/customers/me?email=a@b.com",
      span_id: "ae184987ab65641e",
      trace_id: "17854fec175e4ff4b4c028c5ac19f8ff",
      attributes: {
        "http.target": { value: "/store/carts/cart_1?phone=9812345678", type: "string" },
        "url.query": { value: "phone=9812345678", type: "string" },
        "customer.email": { value: "a@b.com", type: "string" },
        "sentry.segment.id": { value: "8149477152e8aeba", type: "string" },
      },
    } as unknown as Parameters<typeof scrubSpan>[0]
    const out = scrubSpan(span)
    expect(JSON.stringify(out)).not.toMatch(/a@b\.com|9812345678/)
    expect(out.attributes).toMatchObject({ "http.target": { value: "/store/carts/cart_1?phone=[filtered]" }, "customer.email": { value: "[filtered]" }, "sentry.segment.id": { value: "8149477152e8aeba" } })
    expect(out.attributes?.["url.query"]).toBeUndefined()
  })
})
