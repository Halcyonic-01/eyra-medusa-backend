import { model } from "@medusajs/framework/utils"

/**
 * A staff decision to ship an order that is not linked to a checkout, such as
 * one created in Medusa admin. It only waives the checkout link: the order must
 * still have a payment covering what is due. Rows are never edited except to
 * record a revocation, so the table is the audit trail of who allowed what.
 */
export const DispatchOverride = model
  .define("dispatch_override", {
    id: model.id({ prefix: "dovr" }).primaryKey(),
    order_id: model.text(),
    /** The admin user who allowed it. */
    actor_id: model.text(),
    reason: model.text(),
    /** Why the order was held at the time, for the record. */
    held_reason: model.text(),
    revoked_at: model.dateTime().nullable(),
    revoked_by: model.text().nullable(),
  })
  .indexes([
    { on: ["order_id"] },
    // At most one override in force per order.
    { on: ["order_id"], unique: true, where: "revoked_at IS NULL AND deleted_at IS NULL" },
  ])
