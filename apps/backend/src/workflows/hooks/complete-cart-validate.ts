import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { validateCommerceRules } from "./validate-commerce-rules"
import { validateWalletCredit } from "./validate-wallet-credit"

/**
 * The last check before a cart becomes an order. Medusa allows one handler per
 * hook, so every check runs from here: wallet credit first, then the launch
 * rules for shipping and discount codes.
 */
completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  await validateWalletCredit(cart, container)
  await validateCommerceRules(cart, container)
})
