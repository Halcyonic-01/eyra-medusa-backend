import { alreadySent, customerEmailsEnabled, orderEmailBody, sendOrderEmailOnce, sentFlag } from "../customer-email"
import { answer, fakeEmailContainer, fakeStorefront, type FakeOrder } from "./fake-email-container"

const order = (overrides: Partial<FakeOrder> = {}): FakeOrder => ({
  id: "order_1",
  display_id: 42,
  email: "asha@example.com",
  metadata: null,
  shipping_address: { first_name: "Asha" },
  ...overrides,
})

describe("customerEmailsEnabled", () => {
  it("is on unless switched off", () => {
    expect(customerEmailsEnabled({})).toBe(true)
    expect(customerEmailsEnabled({ CUSTOMER_EMAILS_ENABLED: "true" })).toBe(true)
    expect(customerEmailsEnabled({ CUSTOMER_EMAILS_ENABLED: "false" })).toBe(false)
    expect(customerEmailsEnabled({ CUSTOMER_EMAILS_ENABLED: " False " })).toBe(false)
  })
})

describe("what an order remembers", () => {
  it("knows an email was sent from its metadata", () => {
    expect(alreadySent(null, "shipped")).toBe(false)
    expect(alreadySent({}, "shipped")).toBe(false)
    expect(alreadySent({ [sentFlag("shipped")]: "2026-10-29T10:00:00.000Z" }, "shipped")).toBe(true)
    expect(alreadySent({ [sentFlag("shipped")]: "2026-10-29T10:00:00.000Z" }, "delivered")).toBe(false)
  })

  it("builds the body with an idempotency key that names the email and the order", () => {
    const body = orderEmailBody(
      { id: "order_1", display_id: 42, email: "asha@example.com", first_name: "Asha", metadata: null },
      "shipped",
      { type: "order_shipped", awb: "AWB1" }
    )
    expect(body).toEqual({
      type: "order_shipped",
      awb: "AWB1",
      email: "asha@example.com",
      first_name: "Asha",
      order_id: "order_1",
      order_number: 42,
      idempotency_key: "shipped:order_1",
    })
  })
})

describe("sendOrderEmailOnce", () => {
  const saved = { ...process.env }
  let storefront: ReturnType<typeof fakeStorefront>

  beforeEach(() => {
    process.env.STOREFRONT_REVALIDATE_URL = "https://store.test/api/revalidate"
    process.env.STOREFRONT_REVALIDATE_SECRET = "shared"
    delete process.env.CUSTOMER_EMAILS_ENABLED
  })
  afterEach(() => {
    storefront?.restore()
    process.env = { ...saved }
  })

  const fields = () => ({ type: "order_delivered" })

  it("sends, then remembers it on the order", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container, orderUpdates } = fakeEmailContainer({ orders: [order()] })

    await expect(sendOrderEmailOnce(container, "order_1", "delivered", fields)).resolves.toBe("sent")

    expect(storefront.calls).toHaveLength(1)
    expect(storefront.calls[0].path).toBe("/api/wallet/notify")
    expect(storefront.calls[0].secret).toBe("shared")
    expect(storefront.calls[0].body).toMatchObject({
      type: "order_delivered",
      email: "asha@example.com",
      order_number: 42,
      idempotency_key: "delivered:order_1",
    })
    expect(orderUpdates).toHaveLength(1)
    expect(Object.keys(orderUpdates[0].metadata)).toEqual([sentFlag("delivered")])
  })

  it("sends nothing the second time, even when asked twice in a row", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order()] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("sent")
    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("duplicate")
    expect(storefront.calls).toHaveLength(1)
  })

  it("keeps each kind of email separate", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order()] })

    expect(await sendOrderEmailOnce(container, "order_1", "shipped", () => ({ type: "order_shipped" }))).toBe("sent")
    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("sent")
    expect(storefront.calls).toHaveLength(2)
  })

  it("does not call the storefront when the email was already sent", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order({ metadata: { [sentFlag("delivered")]: "earlier" } })] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("duplicate")
    expect(storefront.calls).toHaveLength(0)
  })

  it("does not record an email the storefront could not send, so it can be tried again", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: false }))
    const { container, orderUpdates } = fakeEmailContainer({ orders: [order()] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("failed")
    expect(orderUpdates).toHaveLength(0)

    storefront.restore()
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("sent")
  })

  it("survives the storefront answering with an error or being unreachable", async () => {
    storefront = fakeStorefront(() => answer(500, { error: "boom" }))
    const first = fakeEmailContainer({ orders: [order()] })
    expect(await sendOrderEmailOnce(first.container, "order_1", "delivered", fields)).toBe("failed")
    expect(first.orderUpdates).toHaveLength(0)
    expect(first.log.error.join(" ")).toContain("500")

    storefront.restore()
    storefront = fakeStorefront(() => {
      throw new Error("connection refused")
    })
    const second = fakeEmailContainer({ orders: [order()] })
    expect(await sendOrderEmailOnce(second.container, "order_1", "delivered", fields)).toBe("failed")
    expect(second.orderUpdates).toHaveLength(0)
  })

  it("never throws, even when the order lookup breaks", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order()] })
    const broken = {
      resolve: (key: string) => {
        if (key === "query") throw new Error("database down")
        return container.resolve(key)
      },
    } as any

    await expect(sendOrderEmailOnce(broken, "order_1", "delivered", fields)).resolves.toBe("failed")
    expect(storefront.calls).toHaveLength(0)
  })

  it("skips orders with no email, unknown orders, and messages with nothing to say", async () => {
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order({ email: null }), order({ id: "order_2" })] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("no_email")
    expect(await sendOrderEmailOnce(container, "missing", "delivered", fields)).toBe("not_found")
    expect(await sendOrderEmailOnce(container, "order_2", "delivered", () => null)).toBe("skipped")
    expect(storefront.calls).toHaveLength(0)
  })

  it("does nothing when the storefront is not configured", async () => {
    delete process.env.STOREFRONT_REVALIDATE_URL
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container, orderUpdates } = fakeEmailContainer({ orders: [order()] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("skipped")
    expect(storefront.calls).toHaveLength(0)
    expect(orderUpdates).toHaveLength(0)
  })

  it("does nothing when customer emails are switched off", async () => {
    process.env.CUSTOMER_EMAILS_ENABLED = "false"
    storefront = fakeStorefront(() => answer(200, { sent: true }))
    const { container } = fakeEmailContainer({ orders: [order()] })

    expect(await sendOrderEmailOnce(container, "order_1", "delivered", fields)).toBe("disabled")
    expect(storefront.calls).toHaveLength(0)
  })
})
