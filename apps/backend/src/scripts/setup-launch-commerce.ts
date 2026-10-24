import type { MedusaContainer } from "@medusajs/framework/types"
import { setupLaunchCommerce } from "../utils/setup-launch-commerce"

/**
 * Creates the launch checkout rules: the prepaid and Cash on Delivery shipping
 * options and the three discount codes. Safe
 * to run more than once; it only creates what is missing.
 *
 *   npx medusa exec ./src/scripts/setup-launch-commerce.ts
 */
export default async function setupLaunchCommerceScript({ container }: { container: MedusaContainer }) {
  await setupLaunchCommerce(container)
}
