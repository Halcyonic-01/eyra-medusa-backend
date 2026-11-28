import { captureServerEvent, eventUuid, posthogServerConfig } from "../posthog"
import { num, orderProperties, paymentMethodOf } from "../analytics-orders"
import { dueOrders } from "../../jobs/send-analytics-backlog"

const config = { token: "phc_abcdefghijklmnop", host: "https://eu.i.posthog.com" }
const logger = { warn: jest.fn() }

describe("PostHog server config", () => {
  it("is off without a project token, and refuses a personal (secret) key or an unknown host", () => {
    expect(posthogServerConfig({})).toBeNull()
    expect(posthogServerConfig({ POSTHOG_PROJECT_TOKEN: "phx_secretpersonalkey" })).toBeNull()
    expect(posthogServerConfig({ POSTHOG_PROJECT_TOKEN: config.token, POSTHOG_HOST: "https://evil.example.com" })).toBeNull()
    expect(posthogServerConfig({ POSTHOG_PROJECT_TOKEN: config.token })).toEqual(config)
    expect(posthogServerConfig({ POSTHOG_PROJECT_TOKEN: config.token, POSTHOG_HOST: "https://us.i.posthog.com/" })).toMatchObject({ host: "https://us.i.posthog.com" })
  })
})

describe("event uuids", () => {
  it("are stable per fact and valid UUIDs", () => {
    expect(eventUuid("order_placed:order_1")).toBe(eventUuid("order_placed:order_1"))
    expect(eventUuid("order_placed:order_1")).not.toBe(eventUuid("order_cancelled:order_1"))
    expect(eventUuid("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe("captureServerEvent", () => {
  const event = {
    event: "order_placed",
    distinctId: "cus_01ABCDEFGHIJK",
    dedupeKey: "order_placed:order_1",
    timestamp: new Date("2026-11-28T10:00:00Z"),
    properties: { order_id: "order_1", value: 2499 },
  }
  afterEach(() => jest.restoreAllMocks())

  it("sends one request to the capture endpoint under the customer id", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    expect(await captureServerEvent(event, logger, config)).toBe("sent")
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/")
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toMatchObject({
      api_key: config.token,
      event: "order_placed",
      distinct_id: "cus_01ABCDEFGHIJK",
      uuid: eventUuid("order_placed:order_1"),
      timestamp: "2026-11-28T10:00:00.000Z",
      properties: { order_id: "order_1", value: 2499, $lib: "eyra-backend" },
    })
    expect(body.properties.$process_person_profile).toBeUndefined()
  })

  it("without a customer, counts the event without creating a person", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await captureServerEvent({ ...event, distinctId: null }, logger, config)
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body).toMatchObject({ distinct_id: "order_placed:order_1", properties: { $process_person_profile: false } })
  })

  it("never throws: PostHog down, refusing, or analytics off", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"))
    await expect(captureServerEvent(event, logger, config)).resolves.toBe("failed")
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("no", { status: 500 }))
    await expect(captureServerEvent(event, logger, config)).resolves.toBe("failed")
    await expect(captureServerEvent(event, logger, null)).resolves.toBe("off")
  })
})

describe("order properties", () => {
  const order = {
    id: "order_1",
    customer_id: "cus_01ABCDEFGHIJK",
    currency_code: "inr",
    total: 2499,
    discount_total: 200,
    items: [{ quantity: 2 }, { quantity: 1 }],
    credit_lines: [],
    payment_collections: [{ payments: [{ provider_id: "pp_razorpay_razorpay" }] }],
  }
  it("are ids, amounts and categories only", () => {
    expect(orderProperties(order)).toEqual({
      order_id: "order_1",
      value: 2499,
      currency: "INR",
      item_count: 3,
      payment_method: "razorpay",
      has_discount: true,
      wallet_credit_used: false,
    })
  })
  it("read Medusa's BigNumber shapes", () => {
    expect(num({ numeric: 2, value: "2" })).toBe(2)
    expect(num({ value: "2499.5", precision: 20 })).toBe(2499.5)
    expect(num("3")).toBe(3)
    expect(num(null)).toBe(0)
  })
  it("tell the payment method apart", () => {
    const by = (provider: string, extra = {}) => paymentMethodOf({ ...order, payment_collections: [{ payments: [{ provider_id: provider }] }], ...extra })
    expect(by("pp_payu_payu")).toBe("payu")
    expect(by("pp_system_default")).toBe("cod")
    expect(by("pp_system_default", { total: 1000, credit_lines: [{ amount: 1000 }] })).toBe("wallet")
  })
})

describe("the analytics backlog", () => {
  const now = Date.parse("2026-11-28T12:00:00Z")
  const ago = (minutes: number) => new Date(now - minutes * 60000)
  it("owes events for orders past the grace period, inside the window, never recorded as sent", () => {
    const rows = [
      { id: "fresh", created_at: ago(2) },
      { id: "owed", created_at: ago(30) },
      { id: "sent", created_at: ago(30), metadata: { analytics_placed_sent_at: "x" } },
      { id: "old", created_at: ago(5 * 24 * 60) },
      { id: "cancelled", created_at: ago(60), canceled_at: ago(20), metadata: { analytics_placed_sent_at: "x" } },
    ]
    expect(dueOrders(rows, "order_placed", now)).toEqual(["owed"])
    expect(dueOrders(rows, "order_cancelled", now)).toEqual(["cancelled"])
  })
})
