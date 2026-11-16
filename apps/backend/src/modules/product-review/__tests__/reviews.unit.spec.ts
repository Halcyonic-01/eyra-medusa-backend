import { checkReviewInput, displayNameFor, spamFlags, tidy } from "../content"
import { checkModeration } from "../moderation"
import { decideClaim, emailKey, planNotifications, retryAt } from "../notifications"
import { checkPhoto, sniffImage } from "../photos"
import { publicReview } from "../public"
import { sortOrder, summarise } from "../ratings"
import { hashToken, linkExpiry, linkSecret, linkState, linkToken, reviewLinkBase, reviewLinkUrl, wellFormedToken } from "../tokens"

const DAY = 24 * 3600 * 1000
const now = new Date("2026-11-13T10:00:00Z")

describe("review links", () => {
  it("are rebuilt the same from the request and nonce, and change when the nonce does", () => {
    const a = linkToken("secret", "revreq_1", "n1")
    expect(linkToken("secret", "revreq_1", "n1")).toBe(a)
    expect(linkToken("secret", "revreq_1", "n2")).not.toBe(a)
    expect(linkToken("other", "revreq_1", "n1")).not.toBe(a)
    expect(wellFormedToken(a)).toBe(true)
  })

  it("are stored only as a hash", () => {
    const token = linkToken("secret", "revreq_1", "n1")
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).not.toContain(token)
  })

  it("refuse anything that is not shaped like one of ours", () => {
    for (const bad of ["", "abc", "x".repeat(43) + "!", 42, null, "a".repeat(44)]) expect(wellFormedToken(bad)).toBe(false)
  })

  it("work for 30 days, and once", () => {
    const expires = linkExpiry(now)
    expect(expires.getTime() - now.getTime()).toBe(30 * DAY)
    expect(linkState({ token_expires_at: expires }, now)).toBe("ok")
    expect(linkState({ token_expires_at: expires }, new Date(expires.getTime() + 1))).toBe("expired")
    expect(linkState({ token_expires_at: expires, token_used_at: now }, now)).toBe("used")
  })

  it("need their own secret in production", () => {
    expect(() => linkSecret({ NODE_ENV: "production", JWT_SECRET: "x" })).toThrow(/REVIEW_LINK_SECRET/)
    expect(linkSecret({ NODE_ENV: "production", REVIEW_LINK_SECRET: "own" })).toBe("own")
    expect(linkSecret({ NODE_ENV: "development", JWT_SECRET: "jwt" })).toBe("jwt")
  })

  it("point at the storefront the backend already calls", () => {
    expect(reviewLinkBase({ STOREFRONT_REVALIDATE_URL: "https://eyra.org.in/api/revalidate" })).toBe("https://eyra.org.in")
    expect(reviewLinkBase({ REVIEW_LINK_BASE_URL: "https://shop.example/", STOREFRONT_REVALIDATE_URL: "https://eyra.org.in/x" })).toBe("https://shop.example")
    expect(reviewLinkBase({})).toBeNull()
    expect(reviewLinkUrl("https://eyra.org.in", "tok")).toBe("https://eyra.org.in/review/tok")
  })
})

describe("what a customer writes", () => {
  const base = { line_item_id: "ordli_1", rating: 4, body: "Lovely finish, wear it daily." }

  it("needs a whole rating from 1 to 5 and a few words", () => {
    expect(checkReviewInput(base).ok).toBe(true)
    for (const rating of [0, 6, 3.5, NaN]) expect(checkReviewInput({ ...base, rating }).ok).toBe(false)
    expect(checkReviewInput({ ...base, body: "Nice" }).ok).toBe(false)
    expect(checkReviewInput({ ...base, body: "x".repeat(2001) }).ok).toBe(false)
  })

  it("is tidied, and keeps line breaks", () => {
    expect(tidy("  Great   ring\n\n\n\nwould buy\u0007 again ")).toBe("Great ring\n\nwould buy again")
    const checked = checkReviewInput({ ...base, title: "  So   pretty  " })
    expect(checked.ok && checked.review.title).toBe("So pretty")
  })

  it("cannot put contact details or links in the shown name", () => {
    expect(checkReviewInput({ ...base, display_name: "Priya www.shop.com" }).ok).toBe(false)
    expect(checkReviewInput({ ...base, display_name: "call 9876543210" }).ok).toBe(false)
    expect(checkReviewInput({ ...base, display_name: "Priya S." }).ok).toBe(true)
  })

  it("can carry up to four photos", () => {
    const ids = ["revph_1", "revph_2", "revph_3", "revph_4", "revph_5"]
    expect(checkReviewInput({ ...base, photo_ids: ids.slice(0, 4) }).ok).toBe(true)
    expect(checkReviewInput({ ...base, photo_ids: ids }).ok).toBe(false)
    const deduped = checkReviewInput({ ...base, photo_ids: ["revph_1", "revph_1", "not_a_photo"] })
    expect(deduped.ok && deduped.review.photo_ids).toEqual(["revph_1"])
  })

  it("shows a first name and initial by default", () => {
    expect(displayNameFor("Priya", "Sharma")).toBe("Priya S.")
    expect(displayNameFor("Priya Devi", null)).toBe("Priya")
    expect(displayNameFor(null, "Sharma")).toBe("EYRA customer")
  })
})

describe("spam signals", () => {
  const review = (body: string, title: string | null = null) => ({ title, body, display_name: null })

  it("flag links, contact details, abuse, gibberish, shouting and pasted text for a person to check", () => {
    expect(spamFlags(review("Buy cheap silver at www.fakeshop.com today"))).toContain("link")
    expect(spamFlags(review("WhatsApp me on 98765 43210 for deals"))).toContain("contact_details")
    expect(spamFlags(review("write to me at a@b.co please"))).toContain("contact_details")
    expect(spamFlags(review("this is shit quality honestly"))).toContain("abusive_language")
    expect(spamFlags(review("!!!!!!!!!!!!!!!!!!!!!!!!!!"))).toContain("gibberish")
    expect(spamFlags(review("THIS RING IS THE BEST THING EVER BOUGHT"))).toContain("all_capitals")
    expect(spamFlags(review("Same words here again"), ["same words, here again!"])).toContain("duplicate_text")
  })

  it("never look at the rating: a fair negative review has no flags", () => {
    expect(spamFlags(review("The clasp broke after a week and the polish wore off. Disappointed."))).toEqual([])
  })
})

describe("review messages", () => {
  it("are four rows: the request now, the reminder in three days", () => {
    const rows = planNotifications({ email: "a@b.in", whatsapp_number: "919876543210", whatsapp_opt_in: true }, now)
    expect(rows.map((r) => `${r.stage}:${r.channel}:${r.status}`)).toEqual([
      "request:email:pending",
      "request:whatsapp:pending",
      "reminder:email:scheduled",
      "reminder:whatsapp:scheduled",
    ])
    expect(rows[2].due_at.getTime() - now.getTime()).toBe(3 * DAY)
  })

  it("send no WhatsApp without consent or a mobile number", () => {
    const noConsent = planNotifications({ email: "a@b.in", whatsapp_number: "919876543210", whatsapp_opt_in: false }, now)
    expect(noConsent.filter((r) => r.channel === "whatsapp").every((r) => r.status === "skipped" && r.detail === "no_consent")).toBe(true)
    const noPhone = planNotifications({ email: "a@b.in", whatsapp_number: null, whatsapp_opt_in: true }, now)
    expect(noPhone.filter((r) => r.channel === "whatsapp").every((r) => r.detail === "no_phone")).toBe(true)
    const noEmail = planNotifications({ email: null, whatsapp_number: null, whatsapp_opt_in: false }, now)
    expect(noEmail.every((r) => r.status === "skipped")).toBe(true)
  })

  const row = (over: Record<string, unknown> = {}) => ({
    status: "pending" as const,
    channel: "email" as const,
    stage: "request" as const,
    due_at: now,
    attempts: 0,
    claimed_at: null,
    next_attempt_at: null,
    ...over,
  }) as any

  it("are sent once: anything already out, skipped, cancelled or given up is left alone", () => {
    for (const status of ["sent", "skipped", "cancelled", "gave_up"]) {
      expect(decideClaim(row({ status }), {}, now).action).toBe("done")
    }
    expect(decideClaim(row(), {}, now).action).toBe("send")
  })

  it("wait while another sender holds them, and while not yet due", () => {
    expect(decideClaim(row({ status: "sending", claimed_at: new Date(now.getTime() - 60_000) }), {}, now).action).toBe("wait")
    expect(decideClaim(row({ stage: "reminder", status: "scheduled", due_at: new Date(now.getTime() + DAY) }), {}, now).action).toBe("wait")
    expect(decideClaim(row({ status: "failed", next_attempt_at: new Date(now.getTime() + 60_000) }), {}, now).action).toBe("wait")
  })

  it("cancel the reminder once the customer has reviewed", () => {
    expect(decideClaim(row({ stage: "reminder", status: "scheduled" }), { completed_at: now }, now)).toEqual({ action: "cancel", detail: "reviewed" })
    // The request itself is not called off: it may already be on its way.
    expect(decideClaim(row({ stage: "request" }), { completed_at: now }, now).action).toBe("send")
  })

  it("never send a WhatsApp twice when a send went quiet; email may retry under its key", () => {
    const stale = { status: "sending", claimed_at: new Date(now.getTime() - 60 * 60_000), attempts: 1 }
    expect(decideClaim(row({ ...stale, channel: "whatsapp" }), {}, now)).toEqual({ action: "give_up", detail: "outcome_unknown" })
    expect(decideClaim(row({ ...stale, channel: "email" }), {}, now).action).toBe("send")
    expect(emailKey("reminder", "order_1")).toBe("review_reminder:order_1")
  })

  it("back off, and stop after five tries", () => {
    expect(retryAt(1, now).getTime() - now.getTime()).toBe(15 * 60_000)
    expect(retryAt(4, now).getTime() - now.getTime()).toBe(12 * 3600_000)
    expect(decideClaim(row({ status: "failed", attempts: 5 }), {}, now).action).toBe("give_up")
  })
})

describe("ratings", () => {
  it("come only from what is passed (approved reviews), to one decimal", () => {
    expect(summarise([5, 4, 4, 1])).toEqual({ average: 3.5, count: 4, breakdown: { "1": 1, "2": 0, "3": 0, "4": 2, "5": 1 } })
    expect(summarise([5, 5, 4])).toMatchObject({ average: 4.7, count: 3 })
    expect(summarise([])).toEqual({ average: 0, count: 0, breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } })
    expect(summarise([0, 9, 3]).count).toBe(1)
  })

  it("sort newest, highest or lowest, with the id as the last tie-breaker", () => {
    expect(sortOrder("newest")).toEqual({ submitted_at: "DESC", id: "DESC" })
    expect(sortOrder("highest")).toEqual({ rating: "DESC", submitted_at: "DESC", id: "DESC" })
    expect(sortOrder("lowest")).toEqual({ rating: "ASC", submitted_at: "DESC", id: "DESC" })
  })

  it("show shoppers nothing private", () => {
    const shown = publicReview({
      id: "prev_1",
      rating: 5,
      body: "Great",
      display_name: "Priya S.",
      customer_email: "priya@example.com",
      customer_id: "cus_1",
      order_id: "order_1",
      verified_purchase: true,
      photos: [
        { id: "revph_1", url: "https://x/1.webp", status: "attached" },
        { id: "revph_2", url: "https://x/2.webp", status: "removed" },
      ],
    })
    expect(JSON.stringify(shown)).not.toMatch(/priya@|cus_1|order_1/)
    expect(shown.photos).toEqual([{ id: "revph_1", url: "https://x/1.webp" }])
    expect(shown.verified_purchase).toBe(true)
  })
})

describe("moderation", () => {
  it("approves without a reason", () => {
    expect(checkModeration({ action: "approve" })).toEqual({ ok: true, action: "approve" })
  })

  it("rejects only on a published ground, with a note", () => {
    expect(checkModeration({ action: "reject" }).ok).toBe(false)
    expect(checkModeration({ action: "reject", reason: "spam", note: "short" }).ok).toBe(false)
    expect(checkModeration({ action: "reject", reason: "spam", note: "Advertises another shop's website." })).toMatchObject({ ok: true, reason: "spam" })
  })

  it("has no ground for a bad rating", () => {
    for (const reason of ["negative", "low_rating", "bad_review", "unhappy"]) {
      expect(checkModeration({ action: "reject", reason, note: "Customer was unhappy with it." }).ok).toBe(false)
    }
  })
})

describe("photos", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")])

  it("are recognised by their bytes, not their name", () => {
    expect(sniffImage(png)).toBe("image/png")
    expect(sniffImage(jpeg)).toBe("image/jpeg")
    expect(sniffImage(webp)).toBe("image/webp")
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull()
    expect(sniffImage(Buffer.from("%PDF-1.4"))).toBeNull()
  })

  it("must be a real image under 3 MB", () => {
    expect(checkPhoto(webp.toString("base64"))).toMatchObject({ ok: true, mime: "image/webp" })
    expect(checkPhoto(Buffer.from("GIF89a....").toString("base64")).ok).toBe(false)
    expect(checkPhoto("not base64!!").ok).toBe(false)
    expect(checkPhoto("").ok).toBe(false)
    expect(checkPhoto(Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString("base64")).ok).toBe(false)
  })
})
