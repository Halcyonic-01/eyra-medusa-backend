import { MedusaService } from "@medusajs/framework/utils"
import { Wallet } from "./models/wallet"
import { WalletTransaction } from "./models/wallet-transaction"

class WalletModuleService extends MedusaService({
  Wallet,
  WalletTransaction,
}) {}

export default WalletModuleService
