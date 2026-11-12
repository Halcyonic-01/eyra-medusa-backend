import { MedusaService } from "@medusajs/framework/utils"
import { PaymentPriceSnapshot } from "./models/payment-price-snapshot"

class PaymentSnapshotModuleService extends MedusaService({
  PaymentPriceSnapshot,
}) {}

export default PaymentSnapshotModuleService
