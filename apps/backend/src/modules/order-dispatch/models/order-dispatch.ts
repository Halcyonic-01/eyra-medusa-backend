import { model } from "@medusajs/framework/utils"

/**
 * Where an order is on its way to the courier. One row per order, created when
 * the order is placed. It is the single source of truth for "can this order
 * still be cancelled?" and "has a shipment been created?", so nothing reads
 * Shiprocket's fields to decide that.
 *
 * - placed:          shipment not created yet; the customer's cancel window is open
 *                    until `window_ends_at`
 * - dispatching:     a worker has claimed the order and is creating the shipment
 * - dispatch_failed: creating the shipment failed and nothing exists at the
 *                    courier yet; it is retried until `attempts` runs out
 * - shipped:         the shipment exists (courier order, and normally AWB, label
 *                    and pickup); the order can no longer be cancelled
 * - cancelling:      a customer or staff cancellation is in progress
 * - cancelled:       the order was cancelled before any shipment was created
 *
 * Every move between states is one conditional UPDATE ("only if it is still in
 * the state I expect"), so cancelling and shipping can never both win.
 */
export const OrderDispatch = model
  .define("order_dispatch", {
    id: model.id({ prefix: "odsp" }).primaryKey(),
    order_id: model.text(),
    state: model
      .enum(["placed", "dispatching", "dispatch_failed", "shipped", "cancelling", "cancelled"])
      .default("placed"),
    /** When the cancel window closes and the shipment may be created. */
    window_ends_at: model.dateTime(),
    dispatch_started_at: model.dateTime().nullable(),
    shipped_at: model.dateTime().nullable(),
    /** How many times creating the shipment has been tried. */
    attempts: model.number().default(0),
    next_attempt_at: model.dateTime().nullable(),
    /** The last failure, or a note when the shipment is only partly set up. */
    last_error: model.text().nullable(),
    /** What Shiprocket knows the order as, for example EYRA-21. */
    shiprocket_order_ref: model.text().nullable(),
    shiprocket_order_id: model.text().nullable(),
    shiprocket_shipment_id: model.text().nullable(),
    awb_code: model.text().nullable(),
    courier_name: model.text().nullable(),
    label_url: model.text().nullable(),
    pickup_scheduled: model.boolean().nullable(),
    /** Tax invoice, issued only when the order ships. */
    invoice_fy: model.text().nullable(),
    invoice_seq: model.number().nullable(),
    invoice_number: model.text().nullable(),
    invoice_issued_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      on: ["order_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
    {
      on: ["state", "window_ends_at"],
      where: "deleted_at IS NULL",
    },
    {
      on: ["invoice_number"],
      unique: true,
      where: "invoice_number IS NOT NULL AND deleted_at IS NULL",
    },
  ])
