import { Module } from "@medusajs/framework/utils"
import ReturnRequestModuleService from "./service"

export const RETURN_REQUEST_MODULE = "returnRequest"

export default Module(RETURN_REQUEST_MODULE, {
  service: ReturnRequestModuleService,
})
