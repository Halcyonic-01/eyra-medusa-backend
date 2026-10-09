import { MedusaService } from "@medusajs/framework/utils"
import { InvoiceCounter } from "./models/invoice-counter"
import { OrderCancellation } from "./models/order-cancellation"
import { OrderDispatch } from "./models/order-dispatch"

class OrderDispatchModuleService extends MedusaService({
  OrderDispatch,
  InvoiceCounter,
  OrderCancellation,
}) {}

export default OrderDispatchModuleService
