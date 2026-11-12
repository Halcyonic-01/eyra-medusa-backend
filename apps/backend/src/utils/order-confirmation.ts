import type { Pg } from "../modules/order-dispatch/transitions"

/**
 * Single-statement updates of an order's metadata for the confirmation steps
 * that run after checkout (Razorpay ids, confirmation email). Each merges into
 * the existing metadata, so no other key is lost, and each is conditional, so
 * two callers racing (the browser's verify and Razorpay's webhook) cannot both
 * win or overwrite each other.
 */

/** How long an email claim is honoured before another caller may try again (the sender died). */
export const EMAIL_CLAIM_MINUTES = 10

/** Records the Razorpay ids, unless different ones are already recorded. True when they are now recorded. */
export async function recordRazorpayIds(pg: Pg, orderId: string, razorpayOrderId: string, razorpayPaymentId: string): Promise<boolean> {
  const result = await pg.raw(
    `UPDATE "order"
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('razorpay_order_id', ?::text, 'razorpay_payment_id', ?::text),
            updated_at = now()
      WHERE id = ? AND deleted_at IS NULL
        AND (metadata->>'razorpay_payment_id' IS NULL OR metadata->>'razorpay_payment_id' = ?)
        AND (metadata->>'razorpay_order_id' IS NULL OR metadata->>'razorpay_order_id' = ?)
      RETURNING id`,
    [razorpayOrderId, razorpayPaymentId, orderId, razorpayPaymentId, razorpayOrderId]
  )
  return result.rows.length > 0
}

export type EmailClaim = { claimed: boolean; already_sent: boolean }

/** Takes the right to send the confirmation email, once. A claim older than EMAIL_CLAIM_MINUTES can be taken over. */
export async function claimConfirmationEmail(pg: Pg, orderId: string): Promise<EmailClaim> {
  const result = await pg.raw(
    `UPDATE "order"
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('confirmation_email_claimed_at', now()::text),
            updated_at = now()
      WHERE id = ? AND deleted_at IS NULL
        AND (metadata->>'confirmation_email_sent') IS NULL
        AND ((metadata->>'confirmation_email_claimed_at') IS NULL
             OR (metadata->>'confirmation_email_claimed_at')::timestamptz < now() - (?::int * interval '1 minute'))
      RETURNING id`,
    [orderId, EMAIL_CLAIM_MINUTES]
  )
  if (result.rows.length) return { claimed: true, already_sent: false }
  const state = await pg.raw(`SELECT metadata->>'confirmation_email_sent' AS sent FROM "order" WHERE id = ?`, [orderId])
  return { claimed: false, already_sent: Boolean(state.rows[0]?.sent) }
}

/** Marks the email as sent and drops the claim. */
export async function markConfirmationEmailSent(pg: Pg, orderId: string): Promise<void> {
  await pg.raw(
    `UPDATE "order"
        SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'confirmation_email_claimed_at')
                       || jsonb_build_object('confirmation_email_sent', true),
            updated_at = now()
      WHERE id = ?`,
    [orderId]
  )
}

/** Gives the claim back after a failed send, so a retry can send. */
export async function releaseConfirmationEmail(pg: Pg, orderId: string): Promise<void> {
  await pg.raw(
    `UPDATE "order"
        SET metadata = COALESCE(metadata, '{}'::jsonb) - 'confirmation_email_claimed_at',
            updated_at = now()
      WHERE id = ? AND (metadata->>'confirmation_email_sent') IS NULL`,
    [orderId]
  )
}
