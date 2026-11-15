/** Where a review is. Only approved reviews are ever shown to shoppers. */
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** How the review came in: the link from the review request, or the signed-in order page. */
export const REVIEW_SOURCES = ["link", "account"] as const
export type ReviewSource = (typeof REVIEW_SOURCES)[number]

/**
 * The only grounds for rejecting a review, published in the review policy.
 * A low rating is not one of them: an honest negative review is published
 * like any other (Consumer Protection (E-Commerce) Rules; BIS IS 19000:2022).
 */
export const REJECTION_REASONS = [
  "spam",
  "abusive",
  "personal_information",
  "off_topic",
  "not_genuine",
  "inappropriate_photo",
] as const
export type RejectionReason = (typeof REJECTION_REASONS)[number]

export const REJECTION_LABELS: Record<RejectionReason, string> = {
  spam: "Spam or advertising",
  abusive: "Abusive, hateful or obscene language",
  personal_information: "Personal or contact details",
  off_topic: "Not about the product",
  not_genuine: "Not a genuine customer review",
  inappropriate_photo: "Photo is inappropriate or not of the product",
}

/** Photo states: uploaded (not yet on a review), on a review, or taken off it. */
export const PHOTO_STATUSES = ["uploaded", "attached", "removed"] as const
export type PhotoStatus = (typeof PHOTO_STATUSES)[number]

/** The two messages a review request sends, and the two ways each goes. */
export const NOTIFICATION_STAGES = ["request", "reminder"] as const
export type NotificationStage = (typeof NOTIFICATION_STAGES)[number]
export const NOTIFICATION_CHANNELS = ["email", "whatsapp"] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/**
 * scheduled: waiting for its time (a reminder)
 * pending:   due now
 * sending:   claimed by one sender; nobody else touches it
 * sent:      delivered to the provider
 * failed:    not sent this time; tried again at next_attempt_at
 * gave_up:   failed too often, or the outcome is unknown and a repeat could duplicate it
 * skipped:   not to be sent (no consent, no phone, no email, provider not set up)
 * cancelled: a reminder no longer needed because the customer reviewed
 */
export const NOTIFICATION_STATUSES = [
  "scheduled",
  "pending",
  "sending",
  "sent",
  "failed",
  "gave_up",
  "skipped",
  "cancelled",
] as const
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number]

/** How long a review link works, counted from when it was issued. */
export const REVIEW_LINK_DAYS = 30
/** The reminder goes this long after the first request, if no review came in. */
export const REMINDER_AFTER_DAYS = 3
/** How long a send may stay claimed before it is treated as stuck. */
export const SENDING_STALE_MINUTES = 15
export const MAX_SEND_ATTEMPTS = 5

export const RATING_MIN = 1
export const RATING_MAX = 5
export const TITLE_MAX = 80
export const BODY_MIN = 10
export const BODY_MAX = 2000
export const DISPLAY_NAME_MAX = 40
export const MAX_PHOTOS_PER_REVIEW = 4
/** Photos an order may upload in all, across its reviews and any retries. */
export const MAX_PHOTOS_PER_ORDER = 16
/** The storefront shrinks photos before sending; this is the backend's own ceiling. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024
export const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number]
