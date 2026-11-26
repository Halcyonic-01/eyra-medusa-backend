import { MedusaService } from "@medusajs/framework/utils"
import { LateRazorpayPayment } from "./models/late-razorpay-payment"
import { PaymentPriceSnapshot } from "./models/payment-price-snapshot"
import { PaymentWebhookEvent } from "./models/payment-webhook-event"

class PaymentSnapshotModuleService extends MedusaService({
  PaymentPriceSnapshot,
  LateRazorpayPayment,
  PaymentWebhookEvent,
}) {}

export default PaymentSnapshotModuleService
