import { MedusaService } from "@medusajs/framework/utils"
import { ReturnRequest } from "./models/return-request"

class ReturnRequestModuleService extends MedusaService({
  ReturnRequest,
}) {}

export default ReturnRequestModuleService
