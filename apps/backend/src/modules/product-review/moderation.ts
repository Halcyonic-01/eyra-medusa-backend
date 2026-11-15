import { REJECTION_REASONS, type RejectionReason } from "./constants"

export type ModerationInput = { action: "approve" | "reject"; reason?: string | null; note?: string | null }

export type ModerationCheck =
  | { ok: true; action: "approve" }
  | { ok: true; action: "reject"; reason: RejectionReason; note: string }
  | { ok: false; error: string }

/**
 * A rejection must name one of the published grounds and say why, so every
 * rejection can be audited. There is no ground for a low rating: a review is
 * never rejected for being negative.
 */
export function checkModeration(input: ModerationInput): ModerationCheck {
  if (input.action === "approve") return { ok: true, action: "approve" }
  if (input.action !== "reject") return { ok: false, error: "Choose approve or reject." }
  if (!input.reason || !(REJECTION_REASONS as readonly string[]).includes(input.reason)) {
    return { ok: false, error: `A rejection needs one of the review policy reasons: ${REJECTION_REASONS.join(", ")}.` }
  }
  const note = (input.note ?? "").trim()
  if (note.length < 10) return { ok: false, error: "Say in a sentence what breaks the policy (at least 10 characters)." }
  return { ok: true, action: "reject", reason: input.reason as RejectionReason, note }
}
