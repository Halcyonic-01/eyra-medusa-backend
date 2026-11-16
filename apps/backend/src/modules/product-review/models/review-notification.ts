import { model } from "@medusajs/framework/utils"
import { NOTIFICATION_CHANNELS, NOTIFICATION_STAGES, NOTIFICATION_STATUSES } from "../constants"
import { ReviewRequest } from "./review-request"

/**
 * One message about a review request: the request or the reminder, by email or
 * WhatsApp. There is exactly one row for each, so a message cannot be sent twice:
 * a sender claims the row, sends, and records what happened.
 */
export const ReviewNotification = model
  .define("review_notification", {
    id: model.id({ prefix: "revntf" }).primaryKey(),
    stage: model.enum([...NOTIFICATION_STAGES]),
    channel: model.enum([...NOTIFICATION_CHANNELS]),
    status: model.enum([...NOTIFICATION_STATUSES]),
    /** When it is due: now for the request, three days on for the reminder. */
    due_at: model.dateTime(),
    attempts: model.number().default(0),
    claimed_at: model.dateTime().nullable(),
    next_attempt_at: model.dateTime().nullable(),
    sent_at: model.dateTime().nullable(),
    /** Why it was skipped, or the last error. */
    detail: model.text().nullable(),
    request: model.belongsTo(() => ReviewRequest, { mappedBy: "notifications" }),
  })
  .indexes([
    { on: ["request_id", "stage", "channel"], unique: true, where: "deleted_at IS NULL" },
    { on: ["status", "due_at"] },
  ])
