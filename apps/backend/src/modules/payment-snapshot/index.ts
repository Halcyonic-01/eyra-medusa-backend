import { Module } from "@medusajs/framework/utils"
import PaymentSnapshotModuleService from "./service"

export const PAYMENT_SNAPSHOT_MODULE = "paymentSnapshot"

export default Module(PAYMENT_SNAPSHOT_MODULE, {
  service: PaymentSnapshotModuleService,
})
