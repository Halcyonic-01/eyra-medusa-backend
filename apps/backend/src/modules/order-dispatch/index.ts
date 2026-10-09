import { Module } from "@medusajs/framework/utils"
import OrderDispatchModuleService from "./service"

export const ORDER_DISPATCH_MODULE = "orderDispatch"

export default Module(ORDER_DISPATCH_MODULE, {
  service: OrderDispatchModuleService,
})
