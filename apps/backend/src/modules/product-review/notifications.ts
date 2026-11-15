import {
  MAX_SEND_ATTEMPTS,
  REMINDER_AFTER_DAYS,
  SENDING_STALE_MINUTES,
  type NotificationChannel,
  type NotificationStage,
  type NotificationStatus,
} from "./constants"

const DAY = 24 * 3600 * 1000
const MINUTE = 60 * 1000

export type PlannedNotification = {
  stage: NotificationStage
  channel: NotificationChannel
  status: NotificationStatus
  due_at: Date
  detail: string | null
}

/**
 * The four messages a new review request owns. The request goes now and the
 * reminder three days on; WhatsApp only with the customer's consent and a
 * mobile number, email only with an address.
 */
export function planNotifications(
  who: { email: string | null; whatsapp_number: string | null; whatsapp_opt_in: boolean },
  now: Date
): PlannedNotification[] {
  const reminderAt = new Date(now.getTime() + REMINDER_AFTER_DAYS * DAY)
  const email = who.email ? null : "no_email"
  const whatsapp = !who.whatsapp_opt_in ? "no_consent" : who.whatsapp_number ? null : "no_phone"
  const row = (stage: NotificationStage, channel: NotificationChannel, skip: string | null): PlannedNotification => ({
    stage,
    channel,
    status: skip ? "skipped" : stage === "request" ? "pending" : "scheduled",
    due_at: stage === "request" ? now : reminderAt,
    detail: skip,
  })
  return [
    row("request", "email", email),
    row("request", "whatsapp", whatsapp),
    row("reminder", "email", email),
    row("reminder", "whatsapp", whatsapp),
  ]
}

export type ClaimDecision =
  | { action: "send" }
  | { action: "wait" }
  | { action: "done" }
  | { action: "cancel"; detail: string }
  | { action: "give_up"; detail: string }

/**
 * Whether a sender may send this message now. A message is sent at most once:
 * one that is already out, or skipped, or cancelled is left alone; one claimed
 * by another sender a moment ago is left to it. A claim that went quiet is a
 * send whose result was never recorded: email may be sent again (the provider
 * drops a repeat with the same key), but WhatsApp has no such guard, so it is
 * given up rather than risk a second message.
 */
export function decideClaim(
  row: { status: NotificationStatus; channel: NotificationChannel; stage: NotificationStage; due_at: Date | string; attempts: number; claimed_at?: Date | string | null; next_attempt_at?: Date | string | null },
  request: { completed_at?: Date | string | null },
  now: Date
): ClaimDecision {
  if (row.status === "sent" || row.status === "skipped" || row.status === "cancelled" || row.status === "gave_up") {
    return { action: "done" }
  }
  if (row.stage === "reminder" && request.completed_at) return { action: "cancel", detail: "reviewed" }
  if (row.status === "sending") {
    const claimed = row.claimed_at ? new Date(row.claimed_at).getTime() : 0
    if (now.getTime() - claimed < SENDING_STALE_MINUTES * MINUTE) return { action: "wait" }
    if (row.channel === "whatsapp") return { action: "give_up", detail: "outcome_unknown" }
  }
  if (new Date(row.due_at).getTime() > now.getTime()) return { action: "wait" }
  if (row.status === "failed" && row.next_attempt_at && new Date(row.next_attempt_at).getTime() > now.getTime()) {
    return { action: "wait" }
  }
  if (row.attempts >= MAX_SEND_ATTEMPTS) return { action: "give_up", detail: "too_many_attempts" }
  return { action: "send" }
}

/** 15 minutes, then 1, 4 and 12 hours. */
export function retryAt(attempts: number, now: Date): Date {
  const minutes = [15, 60, 240, 720][Math.min(Math.max(attempts, 1), 4) - 1]
  return new Date(now.getTime() + minutes * MINUTE)
}

/** The key the email provider drops a repeat by, one per order and stage. */
export const emailKey = (stage: NotificationStage, orderId: string): string => `review_${stage}:${orderId}`
