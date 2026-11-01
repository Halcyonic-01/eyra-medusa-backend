import {
  campaignFlag,
  campaignRecipients,
  isSubscribed,
  offerFor,
  runCampaign,
  sendWelcomeOffer,
  type CampaignOptions,
} from "../promotion-email"
import { answer, fakeEmailContainer, fakeStorefront, type FakeCustomer } from "./fake-email-container"

const customer = (id: string, metadata: Record<string, unknown> | null, email: string | null = `${id}@example.com`): FakeCustomer => ({
  id,
  email,
  first_name: "Asha",
  metadata,
})

const subscriber = (id: string, extra: Record<string, unknown> = {}) => customer(id, { newsletter_subscriber: true, ...extra })

describe("who may get offers", () => {
  it("is only people tagged as subscribers", () => {
    expect(isSubscribed({ metadata: { newsletter_subscriber: true } })).toBe(true)
    expect(isSubscribed({ metadata: { newsletter_subscriber: "true" } })).toBe(true)
    expect(isSubscribed({ metadata: { newsletter_subscriber: false } })).toBe(false)
    expect(isSubscribed({ metadata: {} })).toBe(false)
    expect(isSubscribed({ metadata: null })).toBe(false)
  })

  it("leaves out account holders who never signed up, people who unsubscribed, and anyone without an address", () => {
    const people = [
      subscriber("a"),
      customer("b", null),
      customer("c", { newsletter_subscriber: false, unsubscribed_at: "2026-10-01" }),
      customer("d", { newsletter_subscriber: true }, null),
      subscriber("e"),
    ]
    expect(campaignRecipients(people, "diwali").map((c) => c.id)).toEqual(["a", "e"])
  })

  it("leaves out people who already had this campaign, but not other campaigns", () => {
    const people = [subscriber("a", { [campaignFlag("diwali")]: "2026-10-20" }), subscriber("b", { [campaignFlag("spring")]: "2026-03-01" })]
    expect(campaignRecipients(people, "diwali").map((c) => c.id)).toEqual(["b"])
  })
})

describe("offerFor", () => {
  it("reads the amount and minimum from the same rules the cart enforces", () => {
    expect(offerFor("welcome200")).toEqual({ code: "WELCOME200", amount: 200, min_order: 1499 })
    expect(offerFor("EYRA350")).toEqual({ code: "EYRA350", amount: 350, min_order: 3000 })
  })

  it("does not advertise a code that does not exist", () => {
    expect(offerFor("SUMMER90")).toBeNull()
  })
})

describe("emails to subscribers", () => {
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

  describe("welcome offer", () => {
    it("goes to a new subscriber once, with the code and its terms", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container, customerUpdates } = fakeEmailContainer({ customers: [subscriber("cus_1")] })

      expect(await sendWelcomeOffer(container, "cus_1")).toBe("sent")
      expect(storefront.calls[0].body).toMatchObject({
        type: "welcome_offer",
        email: "cus_1@example.com",
        code: "WELCOME200",
        amount: 200,
        min_order: 1499,
        idempotency_key: "welcome-offer:cus_1",
      })
      expect(customerUpdates[0].metadata).toMatchObject({ newsletter_subscriber: true })
      expect(customerUpdates[0].metadata.welcome_offer_sent_at).toBeTruthy()

      expect(await sendWelcomeOffer(container, "cus_1")).toBe("duplicate")
      expect(storefront.calls).toHaveLength(1)
    })

    it("is not sent to a subscriber who has already ordered, since it talks about a first order", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container, customerUpdates } = fakeEmailContainer({
        customers: [subscriber("cus_4")],
        orders: [{ id: "order_1", customer_id: "cus_4", display_id: 1, email: "cus_4@example.com", metadata: null }],
      })

      expect(await sendWelcomeOffer(container, "cus_4")).toBe("skipped")
      expect(storefront.calls).toHaveLength(0)
      expect(customerUpdates).toHaveLength(0)
    })

    it("is sent to an existing customer with no orders once they are tagged, and only once however often they are updated", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container } = fakeEmailContainer({
        customers: [customer("cus_5", { note: "old guest checkout" })],
        orders: [{ id: "order_9", customer_id: "someone-else", display_id: 9, email: "x@example.com", metadata: null }],
      })

      // Updated before they subscribe: nothing.
      expect(await sendWelcomeOffer(container, "cus_5")).toBe("skipped")
      expect(storefront.calls).toHaveLength(0)

      // The signup tags them, and the update event runs the same handler.
      ;(await container.resolve("query").graph({ entity: "customer", filters: { id: "cus_5" }, fields: [] })).data[0].metadata = {
        note: "old guest checkout",
        newsletter_subscriber: true,
      }
      expect(await sendWelcomeOffer(container, "cus_5")).toBe("sent")
      expect(await sendWelcomeOffer(container, "cus_5")).toBe("duplicate")
      expect(storefront.calls).toHaveLength(1)
    })

    it("is not sent to a customer who did not ask for updates", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container } = fakeEmailContainer({ customers: [customer("cus_2", null)] })

      expect(await sendWelcomeOffer(container, "cus_2")).toBe("skipped")
      expect(storefront.calls).toHaveLength(0)
    })

    it("is tried again later when the storefront could not send it", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: false }))
      const { container, customerUpdates } = fakeEmailContainer({ customers: [subscriber("cus_3")] })

      expect(await sendWelcomeOffer(container, "cus_3")).toBe("failed")
      expect(customerUpdates).toHaveLength(0)
    })
  })

  describe("campaign", () => {
    const options = (overrides: Partial<CampaignOptions> = {}): CampaignOptions => ({
      campaign: "diwali-2026",
      subject: "Diwali offer",
      headline: "A little sparkle",
      message: "Our festive pieces are in.",
      ctaLabel: "Shop now",
      ctaPath: "/products",
      code: "EYRA350",
      send: true,
      limit: 50,
      delayMs: 0,
      ...overrides,
    })
    const people = () => [subscriber("a"), subscriber("b"), subscriber("c"), customer("x", null), customer("y", { newsletter_subscriber: false })]

    it("only counts who would get it until sending is asked for", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container, customerUpdates } = fakeEmailContainer({ customers: people() })

      const summary = await runCampaign(container, options({ send: false }))

      expect(summary).toMatchObject({ mode: "preview", subscribers: 3, already_sent: 0, to_send: 3, sent: 0 })
      expect(storefront.calls).toHaveLength(0)
      expect(customerUpdates).toHaveLength(0)
    })

    it("sends to subscribers only, with the offer and a link on our own site", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container, customerUpdates } = fakeEmailContainer({ customers: people() })

      const summary = await runCampaign(container, options())

      expect(summary).toMatchObject({ mode: "send", sent: 3, failed: 0 })
      expect(storefront.calls.map((call) => call.body.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"])
      expect(storefront.calls[0].body).toMatchObject({
        type: "promotion",
        code: "EYRA350",
        amount: 350,
        min_order: 3000,
        cta_url: "https://www.eyra.org.in/products",
        idempotency_key: "promo:diwali-2026:a",
      })
      expect(customerUpdates).toHaveLength(3)
    })

    it("stops at the limit, and a second run carries on with the rest", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container } = fakeEmailContainer({ customers: people() })

      expect((await runCampaign(container, options({ limit: 1 }))).sent).toBe(1)
      const second = await runCampaign(container, options())

      expect(second).toMatchObject({ already_sent: 1, sent: 2 })
      expect(storefront.calls.map((call) => call.body.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"])
    })

    it("does not mark customers whose email failed, and counts them", async () => {
      storefront = fakeStorefront((_path, body) => answer(200, { sent: body.email !== "b@example.com" }))
      const { container, customerUpdates } = fakeEmailContainer({ customers: people() })

      const summary = await runCampaign(container, options())

      expect(summary).toMatchObject({ sent: 2, failed: 1 })
      expect(customerUpdates.map((u) => u.id)).toEqual(["a", "c"])
    })

    it("sends nothing when customer emails are switched off", async () => {
      process.env.CUSTOMER_EMAILS_ENABLED = "false"
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container } = fakeEmailContainer({ customers: people() })

      expect((await runCampaign(container, options())).sent).toBe(0)
      expect(storefront.calls).toHaveLength(0)
    })

    it("refuses a code that is not a real discount, a bad name, or a link that is not a path", async () => {
      storefront = fakeStorefront(() => answer(200, { sent: true }))
      const { container } = fakeEmailContainer({ customers: people() })

      await expect(runCampaign(container, options({ code: "SUMMER90" }))).rejects.toThrow("SUMMER90")
      await expect(runCampaign(container, options({ campaign: "Bad Name!" }))).rejects.toThrow("campaign")
      await expect(runCampaign(container, options({ ctaPath: "https://evil.example" }))).rejects.toThrow("path")
      expect(storefront.calls).toHaveLength(0)
    })
  })
})
