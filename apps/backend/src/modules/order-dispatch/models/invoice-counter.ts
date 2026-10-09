import { model } from "@medusajs/framework/utils"

/**
 * The last tax invoice number issued in each financial year. A number is only
 * taken when an order ships, inside the same transaction that marks it shipped,
 * so cancelled orders never leave a gap in the series.
 */
export const InvoiceCounter = model
  .define("invoice_counter", {
    id: model.id({ prefix: "invc" }).primaryKey(),
    /** Financial year label, for example "26-27". */
    fy: model.text(),
    last_seq: model.number().default(0),
  })
  .indexes([
    {
      on: ["fy"],
      unique: true,
      where: "deleted_at IS NULL",
    },
  ])
