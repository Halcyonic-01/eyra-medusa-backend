import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { alreadyOrdered } from "./already-ordered"
import { leftoverOrdersOfCart, performOrphanVoid } from "../steps/void-orphan-order"
import { validateCommerceRules } from "./validate-commerce-rules"
import { validateCurrentPrices } from "./validate-current-prices"
import { validateWalletCredit } from "./validate-wallet-credit"

/**
 * The last check before a cart becomes an order. Medusa allows one handler per
 * hook, so every check runs from here: current prices first, then wallet
 * credit, then the launch rules for shipping and discount codes. A repeat
 * completion of a cart that is already an order is not checked again.
 */
completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  if (await alreadyOrdered(cart, container)) return
  await clearLeftovers(cart.id, container)
  await validateCurrentPrices(cart, container)
  await validateWalletCredit(cart, container)
  await validateCommerceRules(cart, container)
})

/**
 * A retry of a cart whose earlier completion crashed: void that attempt's
 * leftover order first, so a once-per-customer code it consumed is given back
 * before Medusa counts the code again for the real order. Medusa holds this
 * cart's completion lock here. A failure is logged and the completion goes on.
 */
async function clearLeftovers(cartId: string, container: MedusaContainer) {
  try {
    for (const orderId of await leftoverOrdersOfCart(container, cartId)) {
      await performOrphanVoid(container, orderId, { cartLockHeld: true })
    }
  } catch (error) {
    container.resolve(ContainerRegistrationKeys.LOGGER).error(`[order-integrity] could not clear leftovers of ${cartId}: ${(error as Error).message}`)
  }
}
