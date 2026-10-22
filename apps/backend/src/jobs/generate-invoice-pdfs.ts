import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { generateInvoicePdfWorkflow } from "../workflows/generate-invoice-pdf"
import { isDueForPdf } from "../utils/invoice-pdf-state"
import { postToStorefront } from "../utils/storefront"

type Pg = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: { id: string; display_id: number; metadata: Record<string, unknown> | null }[] }> }

/** How many orders one run draws, so a backlog cannot swamp the storefront. */
const BATCH = 20

/**
 * Draws and stores the tax invoice PDF for orders that have shipped and have no
 * stored PDF yet. Runs behind shipping, never in front of it: an order is
 * already shipped, with its invoice number issued, before this looks at it, so
 * a slow or failing storefront cannot hold a parcel back. Orders that fail are
 * retried with a growing delay, and the team is told once if one keeps failing.
 */
export default async function generateInvoicePdfsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg

  const { rows } = await pg.raw(
    `SELECT id, display_id, metadata FROM "order"
      WHERE deleted_at IS NULL
        AND jsonb_exists(metadata, 'invoice_number')
        AND NOT jsonb_exists(metadata, 'invoice_pdf')
      ORDER BY created_at
      LIMIT 200`
  )

  const now = new Date()
  const due = rows.filter((row) => isDueForPdf(row.metadata, now)).slice(0, BATCH)

  for (const order of due) {
    try {
      const { result } = await generateInvoicePdfWorkflow(container).run({ input: { order_id: order.id } })
      if (result.status === "stored") {
        logger.info(`[invoice] stored the PDF for order ${order.id}`)
      } else if (result.status === "failed") {
        logger.warn(`[invoice] order ${order.id}: ${result.code}: ${result.message} (attempt ${result.attempts})`)
        if (result.gave_up) {
          await postToStorefront(
            "/api/ops/notify",
            {
              type: "invoice_pdf_failed",
              order_id: order.id,
              order_ref: `EYRA-${order.display_id}`,
              attempts: result.attempts,
              error: `${result.code}: ${result.message}`,
            },
            logger
          )
        }
      }
    } catch (error) {
      logger.error(`[invoice] could not generate the PDF for order ${order.id}: ${(error as Error).message}`)
    }
  }
}

export const config = {
  name: "generate-invoice-pdfs",
  schedule: "*/5 * * * *",
}
