import {
  BODY_MAX,
  BODY_MIN,
  DISPLAY_NAME_MAX,
  MAX_PHOTOS_PER_REVIEW,
  RATING_MAX,
  RATING_MIN,
  TITLE_MAX,
} from "./constants"

/** What a customer sends for one product. */
export type ReviewInput = {
  line_item_id: string
  rating: number
  title?: string | null
  body: string
  display_name?: string | null
  photo_ids?: string[]
}

export type CleanReview = {
  line_item_id: string
  rating: number
  title: string | null
  body: string
  display_name: string | null
  photo_ids: string[]
}

/** Trims, folds runs of spaces and drops control characters. Line breaks stay. */
export function tidy(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export type InputCheck = { ok: true; review: CleanReview } | { ok: false; error: string }

export function checkReviewInput(input: ReviewInput): InputCheck {
  const rating = Number(input.rating)
  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return { ok: false, error: `Choose a rating from ${RATING_MIN} to ${RATING_MAX} stars.` }
  }
  const body = tidy(String(input.body ?? ""))
  if (body.length < BODY_MIN) return { ok: false, error: `Please write at least ${BODY_MIN} characters.` }
  if (body.length > BODY_MAX) return { ok: false, error: `Please keep your review under ${BODY_MAX} characters.` }
  const title = input.title ? tidy(String(input.title)).replace(/\n/g, " ") : ""
  if (title.length > TITLE_MAX) return { ok: false, error: `Please keep the title under ${TITLE_MAX} characters.` }
  const name = input.display_name ? tidy(String(input.display_name)).replace(/\n/g, " ") : ""
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, error: `Please keep your name under ${DISPLAY_NAME_MAX} characters.` }
  if (name && (URL_RE.test(name) || EMAIL_RE.test(name) || PHONE_RE.test(name))) {
    return { ok: false, error: "Your name cannot contain links or contact details." }
  }
  const photoIds = [...new Set((input.photo_ids ?? []).filter((id) => typeof id === "string" && id.startsWith("revph_")))]
  if (photoIds.length > MAX_PHOTOS_PER_REVIEW) {
    return { ok: false, error: `You can add up to ${MAX_PHOTOS_PER_REVIEW} photos to a review.` }
  }
  return {
    ok: true,
    review: { line_item_id: input.line_item_id, rating, title: title || null, body, display_name: name || null, photo_ids: photoIds },
  }
}

const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|in|net|org|io|co|shop|xyz|link|ly)\b/i
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/
/** A short list of clear slurs and obscenities, English and Hindi. A flag for a person to check, not a filter. */
const ABUSE_RE = /\b(fuck\w*|shit\w*|bitch\w*|bastard|asshole|chutiya|madarchod|bhenchod|behenchod|randi|harami)\b/i

/**
 * Signs a moderator should look closer. They never reject a review on their
 * own, and nothing here looks at how many stars it has.
 */
export function spamFlags(review: { title: string | null; body: string; display_name: string | null }, others: string[] = []): string[] {
  const text = `${review.title ?? ""}\n${review.body}`
  const flags: string[] = []
  if (URL_RE.test(text)) flags.push("link")
  if (EMAIL_RE.test(text) || PHONE_RE.test(text)) flags.push("contact_details")
  if (ABUSE_RE.test(text)) flags.push("abusive_language")
  const letters = text.replace(/[^\p{L}]/gu, "")
  if (letters.length < text.replace(/\s/g, "").length * 0.5 || /(.)\1{6,}/.test(text)) flags.push("gibberish")
  if (/[A-Z]/.test(text) && letters.length >= 20 && letters === letters.toUpperCase()) flags.push("all_capitals")
  const normal = normalise(review.body)
  if (others.some((other) => normalise(other) === normal)) flags.push("duplicate_text")
  return flags
}

const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** "Priya Sharma" becomes "Priya S.": first name and initial, never the full surname. */
export function displayNameFor(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = tidy(firstName ?? "").split(/\s+/)[0] ?? ""
  const initial = tidy(lastName ?? "").charAt(0).toUpperCase()
  if (!first) return "EYRA customer"
  return initial ? `${first} ${initial}.` : first
}
