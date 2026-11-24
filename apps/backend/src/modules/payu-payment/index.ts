import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PayuProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [PayuProviderService],
})
