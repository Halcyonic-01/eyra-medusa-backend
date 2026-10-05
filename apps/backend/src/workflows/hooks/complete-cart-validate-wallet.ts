import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { WALLET_MODULE } from "../../modules/wallet"
import { spendableBalance } from "../../modules/wallet/lots"
import type WalletModuleService from "../../modules/wallet/service"
import {
  WALLET_CREDIT_LINE_REFERENCE,
  toNumber,
} from "../../modules/wallet/utils"

type CartCreditLine = {
  amount: unknown
  reference?: string | null
  reference_id?: string | null
}

/**
 * Last check before a cart becomes an order: any wallet credit on the cart
 * must still be there. The balance can change between applying credit and
 * paying (a second order placed in another tab, for example), and an order
 * must never be placed on credit the customer no longer has.
 */
completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const walletService: WalletModuleService = container.resolve(WALLET_MODULE)

  const { data: carts } = await query.graph({
    entity: "cart",
    fields: ["id", "credit_lines.*"],
    filters: { id: cart.id },
  })

  const lines = ((carts[0]?.credit_lines ?? []) as CartCreditLine[]).filter(
    (line) => line.reference === WALLET_CREDIT_LINE_REFERENCE && line.reference_id
  )

  const needed = new Map<string, number>()
  for (const line of lines) {
    const walletId = line.reference_id as string
    needed.set(walletId, (needed.get(walletId) ?? 0) + toNumber(line.amount))
  }

  for (const [walletId, amount] of needed) {
    // Spendable credit only: a batch that has expired no longer counts.
    if ((await spendableBalance(walletService, walletId)) < amount) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Your wallet balance has changed. Please remove wallet credit and apply it again."
      )
    }
  }
})
