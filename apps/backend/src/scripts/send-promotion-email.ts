import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { runCampaign } from "../utils/promotion-email"

/**
 * Emails an offer to the customers who signed up for updates.
 *
 * It only counts who would get it, until send=true is added. Everyone gets a
 * given campaign once, so running it again carries on where it stopped.
 *
 *   npx medusa exec ./src/scripts/send-promotion-email.ts \
 *     campaign=diwali-2026 code=EYRA350 \
 *     subject="Diwali, with Rs 350 off" headline="A little sparkle for Diwali" \
 *     message="Our festive pieces are in. Use your code at checkout." \
 *     cta=/products ctaLabel="Shop the collection" limit=1 send=true
 *
 * Whether the email really goes to customers is up to the storefront the backend
 * is pointed at (STOREFRONT_REVALIDATE_URL): in test mode it goes to the test
 * address only. Start with limit=1.
 */
export default async function sendPromotionEmailScript({ container, args }: { container: MedusaContainer; args?: string[] }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const given = Object.fromEntries(
    (args ?? []).map((arg) => {
      const at = arg.indexOf("=")
      return at === -1 ? [arg, ""] : [arg.slice(0, at), arg.slice(at + 1)]
    })
  )

  const missing = ["campaign", "subject", "headline", "message"].filter((name) => !given[name])
  if (missing.length) {
    logger.error(`[promotion] missing: ${missing.join(", ")}. See the notes at the top of this script.`)
    return
  }

  const limit = Number(given.limit ?? "50")
  if (!Number.isInteger(limit) || limit < 1) {
    logger.error("[promotion] limit must be a whole number of at least 1")
    return
  }

  const summary = await runCampaign(container, {
    campaign: given.campaign,
    subject: given.subject,
    headline: given.headline,
    message: given.message,
    ctaLabel: given.ctaLabel ?? "Shop now",
    ctaPath: given.cta ?? "/products",
    code: given.code,
    send: given.send === "true",
    limit,
  })
  logger.info(`[promotion] ${JSON.stringify(summary)}`)
  if (summary.mode === "preview") {
    logger.info("[promotion] preview only: nothing was sent. Add send=true to send.")
  }
}
