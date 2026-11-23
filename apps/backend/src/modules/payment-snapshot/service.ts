import { MedusaService } from "@medusajs/framework/utils"
import { LateRazorpayPayment } from "./models/late-razorpay-payment"
import { PaymentPriceSnapshot } from "./models/payment-price-snapshot"

class PaymentSnapshotModuleService extends MedusaService({
  PaymentPriceSnapshot,
  LateRazorpayPayment,
}) {}

export default PaymentSnapshotModuleService
