import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Lists product images that are NOT on safe, persistent hosting, so they can be
 * re-uploaded after file storage moves to S3. Read-only: it changes nothing.
 *
 *   npx medusa exec ./src/scripts/audit-product-images.ts
 *
 * An image is flagged when its address points at this server's own disk
 * (".../static/..." or localhost), which is lost on every Railway deploy, or
 * when it is not on a host named in SAFE_IMAGE_HOSTS (comma separated, default:
 * the S3_FILE_URL host and eyra.org.in).
 */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export default async function auditProductImages({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const safe = new Set(
    [
      ...(process.env.SAFE_IMAGE_HOSTS ?? "").split(","),
      hostOf(process.env.S3_FILE_URL ?? ""),
      "eyra.org.in",
      "www.eyra.org.in",
    ]
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title", "thumbnail", "images.id", "images.url"],
  })

  const flagged: { product: string; url: string; why: string }[] = []
  for (const product of products) {
    const urls = new Set<string>()
    if (product.thumbnail) urls.add(product.thumbnail)
    for (const image of product.images ?? []) if (image?.url) urls.add(image.url)

    for (const url of urls) {
      const host = hostOf(url)
      const onDisk = /\/static\//.test(url) || host === "localhost" || host === "127.0.0.1"
      if (onDisk) {
        flagged.push({ product: product.handle as string, url, why: "on the server's own disk (lost on deploy)" })
      } else if (!safe.has(host)) {
        flagged.push({ product: product.handle as string, url, why: `host "${host}" is not on the safe list` })
      }
    }
  }

  if (!flagged.length) {
    logger.info(`All images on ${products.length} product(s) are on safe hosting.`)
    return
  }

  logger.warn(`${flagged.length} image(s) need re-uploading:`)
  for (const entry of flagged) {
    logger.warn(`  ${entry.product}: ${entry.url}  (${entry.why})`)
  }
  logger.warn("Re-upload each in the Medusa admin (Products, open the product, Media) once S3 is configured.")
}
