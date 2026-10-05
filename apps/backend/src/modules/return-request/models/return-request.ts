import { model } from "@medusajs/framework/utils"

/**
 * A customer's request to return, or exchange, items from an order. Staff
 * review it; approving it issues wallet credit for the agreed amount.
 */
export const ReturnRequest = model
  .define("return_request", {
    id: model.id({ prefix: "retreq" }).primaryKey(),
    order_id: model.text(),
    customer_id: model.text(),
    type: model.enum(["return", "exchange"]),
    reason: model.enum([
      "wrong_size",
      "damaged_or_defective",
      "not_as_described",
      "changed_mind",
      "other",
    ]),
    note: model.text().nullable(),
    /** Snapshot of what was requested: item_id, title, quantity, unit_price. */
    items: model.json(),
    status: model.enum(["pending", "approved", "rejected"]).default("pending"),
    /** Wallet credit issued, when approved. */
    credit_amount: model.bigNumber().nullable(),
    /** Staff's message back to the customer. */
    resolution_note: model.text().nullable(),
    resolved_by: model.text().nullable(),
    resolved_at: model.dateTime().nullable(),
  })
  .indexes([
    { on: ["order_id"] },
    { on: ["customer_id"] },
    { on: ["status"] },
  ])
