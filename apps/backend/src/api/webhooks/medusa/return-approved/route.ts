import { timingSafeEqual } from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { completeReceivedReturnWorkflow } from "../../../../workflows/complete-received-return"

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * POST /webhooks/medusa/return-approved   { "return_request_id": "retreq_..." }
 *
 * Runs the same finish as the order.return_received event for one request: draw
 * and store the credit note PDF, then issue the store credit (or send the
 * replacement for an exchange). It is for anything that has to trigger or retry
 * that from outside. Sign-in is the shared internal secret in x-shipment-secret
 * (STOREFRONT_SHIPMENT_SECRET, or STOREFRONT_REVALIDATE_SECRET while that is
 * not set); with neither set the route is closed. Safe to call again: nothing is
 * numbered, credited or shipped twice. A request that was not received yet is refused.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const secret = process.env.STOREFRONT_SHIPMENT_SECRET || process.env.STOREFRONT_REVALIDATE_SECRET
  if (!secret) return res.status(503).json({ error: "Webhook not configured" })
  const header = process.env.STOREFRONT_SHIPMENT_SECRET ? "x-shipment-secret" : "x-revalidate-secret"
  const given = req.headers[header]
  if (typeof given !== "string" || !safeEqual(given, secret)) return res.status(401).json({ error: "Unauthorized" })

  const id = (req.body as { return_request_id?: unknown } | undefined)?.return_request_id
  if (typeof id !== "string" || !id.startsWith("retreq_")) {
    return res.status(400).json({ error: "return_request_id is required" })
  }

  try {
    const { result } = await completeReceivedReturnWorkflow(req.scope).run({ input: { request_id: id } })
    return res.status(200).json({ received: true, ...result })
  } catch (error) {
    // A workflow hands errors back with their type but not always as the same class.
    const type = (error as { type?: string }).type
    if (type === MedusaError.Types.NOT_FOUND) return res.status(404).json({ error: (error as Error).message })
    if (type === MedusaError.Types.NOT_ALLOWED || type === MedusaError.Types.INVALID_DATA) {
      return res.status(409).json({ error: (error as Error).message })
    }
    logger.error(`[return] could not finish ${id}: ${(error as Error).message}`)
    return res.status(500).json({ error: "Could not finish the request" })
  }
}
