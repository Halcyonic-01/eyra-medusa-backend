import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { EyraRazorpayProviderService } from "./service"

/**
 * The Razorpay plugin's provider with EYRA's refund fix (see service.ts).
 * Registered with id "razorpay", so its provider id stays pp_razorpay_razorpay.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [EyraRazorpayProviderService],
})
