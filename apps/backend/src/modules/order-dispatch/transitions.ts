import { generateEntityId } from "@medusajs/framework/utils"
import { MAX_DISPATCH_ATTEMPTS } from "./config"
import { financialYearLabel, formatInvoiceNumber } from "./invoice"

/**
 * Every move between dispatch states, as one conditional UPDATE ("only if the
 * row is still in the state I expect"). The database decides who wins when two
 * things race, for example a customer cancelling while the dispatcher ships, so
 * this does not depend on in-process locks.
 */

/** The part of the Postgres connection Medusa hands out that these functions use. */
export type Pg = {
  raw: (sql: string, bindings?: readonly unknown[]) => PromiseLike<{ rows: Record<string, unknown>[] }>
  transaction: <T>(work: (trx: Pg) => Promise<T>) => Promise<T>
}

export type DispatchRow = {
  id: string
  order_id: string
  state: string
  window_ends_at: Date
  dispatch_started_at: Date | null
  shipped_at: Date | null
  attempts: number
  next_attempt_at: Date | null
  last_error: string | null
  shiprocket_order_ref: string | null
  shiprocket_order_id: string | null
  shiprocket_shipment_id: string | null
  awb_code: string | null
  courier_name: string | null
  label_url: string | null
  pickup_scheduled: boolean | null
  invoice_fy: string | null
  invoice_seq: number | null
  invoice_number: string | null
  invoice_issued_at: Date | null
}

export type ShipmentDetails = {
  shiprocket_order_ref: string | null
  shiprocket_order_id: string | null
  shiprocket_shipment_id: string
  awb_code: string | null
  courier_name: string | null
  label_url: string | null
  pickup_scheduled: boolean | null
  /** Set when the shipment exists but is not fully set up (for example no label). */
  note: string | null
}

function firstRow(result: { rows: Record<string, unknown>[] }): DispatchRow | null {
  return (result.rows[0] as DispatchRow | undefined) ?? null
}

/**
 * Takes an order for dispatching: from `placed` once its window has closed (or
 * at once when `force` is set, as with "Ship now"), or from `dispatch_failed`
 * when a retry is due. Returns the claimed row, or null when someone else got
 * there first or the order is not due.
 */
export async function claimDispatch(
  pg: Pg,
  orderId: string,
  force: boolean
): Promise<DispatchRow | null> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'dispatching',
            dispatch_started_at = now(),
            attempts = attempts + 1,
            next_attempt_at = NULL,
            updated_at = now()
      WHERE order_id = ?
        AND deleted_at IS NULL
        AND (
          (state = 'placed' AND (?::boolean OR window_ends_at <= now()))
          OR (state = 'dispatch_failed' AND (?::boolean OR (attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= now()))))
        )
      RETURNING *`,
    [orderId, force, force, MAX_DISPATCH_ATTEMPTS]
  )
  return firstRow(result)
}

/**
 * Gives a claimed order back for a later retry, recording why. Only acts on an
 * order that is still `dispatching`, so it can never undo a finished shipment.
 */
export async function markDispatchFailed(
  pg: Pg,
  orderId: string,
  error: string,
  retryInMinutes: number
): Promise<DispatchRow | null> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'dispatch_failed',
            last_error = ?,
            next_attempt_at = now() + (?::int * interval '1 minute'),
            updated_at = now()
      WHERE order_id = ? AND state = 'dispatching' AND deleted_at IS NULL
      RETURNING *`,
    [error.slice(0, 500), retryInMinutes, orderId]
  )
  return firstRow(result)
}

/**
 * Records the finished shipment and issues the tax invoice number in the same
 * transaction. If the order is no longer `dispatching` nothing is changed and
 * the number is not used, so the series has no gaps.
 */
export async function markShipped(
  pg: Pg,
  orderId: string,
  shipment: ShipmentDetails,
  invoicePrefix: string,
  now: Date = new Date()
): Promise<DispatchRow | null> {
  const NOT_CLAIMED = Symbol("not-claimed")
  try {
    return await pg.transaction(async (trx) => {
      const fy = financialYearLabel(now)
      const counter = await trx.raw(
        `INSERT INTO invoice_counter (id, fy, last_seq, created_at, updated_at)
              VALUES (?, ?, 1, now(), now())
         ON CONFLICT (fy) WHERE deleted_at IS NULL
           DO UPDATE SET last_seq = invoice_counter.last_seq + 1, updated_at = now()
           RETURNING last_seq`,
        [generateEntityId(undefined, "invc"), fy]
      )
      const seq = Number(counter.rows[0].last_seq)

      const result = await trx.raw(
        `UPDATE order_dispatch
            SET state = 'shipped',
                shipped_at = now(),
                last_error = ?,
                shiprocket_order_ref = ?,
                shiprocket_order_id = ?,
                shiprocket_shipment_id = ?,
                awb_code = ?,
                courier_name = ?,
                label_url = ?,
                pickup_scheduled = ?,
                invoice_fy = ?,
                invoice_seq = ?,
                invoice_number = ?,
                invoice_issued_at = now(),
                updated_at = now()
          WHERE order_id = ? AND state = 'dispatching' AND deleted_at IS NULL
          RETURNING *`,
        [
          shipment.note,
          shipment.shiprocket_order_ref,
          shipment.shiprocket_order_id,
          shipment.shiprocket_shipment_id,
          shipment.awb_code,
          shipment.courier_name,
          shipment.label_url,
          shipment.pickup_scheduled,
          fy,
          seq,
          formatInvoiceNumber(invoicePrefix, fy, seq),
          orderId,
        ]
      )

      const row = firstRow(result)
      if (!row) {
        throw NOT_CLAIMED
      }
      return row
    })
  } catch (error) {
    if (error === NOT_CLAIMED) {
      return null
    }
    throw error
  }
}

/**
 * Closes an order that was cancelled while its shipment was being created. The
 * shipment is recorded, but no tax invoice number is used for a cancelled sale.
 */
export async function markCancelledWithShipment(
  pg: Pg,
  orderId: string,
  shipment: ShipmentDetails
): Promise<DispatchRow | null> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'cancelled',
            last_error = 'Cancelled while the shipment was being created, so the shipment must be cancelled in Shiprocket',
            shiprocket_order_ref = ?,
            shiprocket_order_id = ?,
            shiprocket_shipment_id = ?,
            awb_code = ?,
            courier_name = ?,
            label_url = ?,
            pickup_scheduled = ?,
            updated_at = now()
      WHERE order_id = ? AND state = 'dispatching' AND deleted_at IS NULL
      RETURNING *`,
    [
      shipment.shiprocket_order_ref,
      shipment.shiprocket_order_id,
      shipment.shiprocket_shipment_id,
      shipment.awb_code,
      shipment.courier_name,
      shipment.label_url,
      shipment.pickup_scheduled,
      orderId,
    ]
  )
  return firstRow(result)
}

/** Closes an order that was cancelled before any shipment was created. */
export async function markCancelled(
  pg: Pg,
  orderId: string,
  fromStates: readonly string[]
): Promise<DispatchRow | null> {
  const placeholders = fromStates.map(() => "?").join(", ")
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'cancelled', updated_at = now()
      WHERE order_id = ? AND state IN (${placeholders}) AND deleted_at IS NULL
      RETURNING *`,
    [orderId, ...fromStates]
  )
  return firstRow(result)
}

/**
 * Finds orders left `dispatching` by a worker that stopped (a crash or a
 * restart) and hands them back for a retry.
 */
export async function recoverStalled(
  pg: Pg,
  stalledAfterMinutes: number
): Promise<{ order_id: string; attempts: number }[]> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'dispatch_failed',
            last_error = 'Dispatch was interrupted before it finished',
            next_attempt_at = now(),
            updated_at = now()
      WHERE state = 'dispatching'
        AND deleted_at IS NULL
        AND dispatch_started_at < now() - (?::int * interval '1 minute')
      RETURNING order_id, attempts`,
    [stalledAfterMinutes]
  )
  return result.rows as { order_id: string; attempts: number }[]
}

/** The JSON-safe form of a row, for passing between workflow steps and out of the API. */
export type DispatchSnapshot = {
  id: string
  order_id: string
  state: string
  window_ends_at: string
  dispatch_started_at: string | null
  shipped_at: string | null
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  shiprocket_order_ref: string | null
  shiprocket_order_id: string | null
  shiprocket_shipment_id: string | null
  awb_code: string | null
  courier_name: string | null
  label_url: string | null
  pickup_scheduled: boolean | null
  invoice_number: string | null
  invoice_issued_at: string | null
}

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null

export function toSnapshot(row: DispatchRow): DispatchSnapshot {
  return {
    id: row.id,
    order_id: row.order_id,
    state: row.state,
    window_ends_at: new Date(row.window_ends_at).toISOString(),
    dispatch_started_at: iso(row.dispatch_started_at),
    shipped_at: iso(row.shipped_at),
    attempts: Number(row.attempts),
    next_attempt_at: iso(row.next_attempt_at),
    last_error: row.last_error,
    shiprocket_order_ref: row.shiprocket_order_ref,
    shiprocket_order_id: row.shiprocket_order_id,
    shiprocket_shipment_id: row.shiprocket_shipment_id,
    awb_code: row.awb_code,
    courier_name: row.courier_name,
    label_url: row.label_url,
    pickup_scheduled: row.pickup_scheduled,
    invoice_number: row.invoice_number,
    invoice_issued_at: iso(row.invoice_issued_at),
  }
}

/**
 * Starts a cancellation: only from `placed`, and only while the cancel window is
 * still open. Returns the row, or null when the shipment is already being
 * created or exists, or the window has closed. This is the one atomic switch
 * that makes cancelling and shipping mutually exclusive.
 */
export async function markCancelling(pg: Pg, orderId: string): Promise<DispatchRow | null> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'cancelling', last_error = NULL, updated_at = now()
      WHERE order_id = ?
        AND state = 'placed'
        AND window_ends_at > now()
        AND deleted_at IS NULL
      RETURNING *`,
    [orderId]
  )
  return firstRow(result)
}

/** Puts an order back in its cancel window after a cancellation that did not go through. */
export async function releaseCancelling(pg: Pg, orderId: string): Promise<DispatchRow | null> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET state = 'placed', updated_at = now()
      WHERE order_id = ? AND state = 'cancelling' AND deleted_at IS NULL
      RETURNING *`,
    [orderId]
  )
  return firstRow(result)
}

/**
 * Records why a cancellation stopped halfway, on an order still `cancelling`.
 * It keeps the order held, and stops the stalled-cancellation check from
 * telling staff a second time.
 */
export async function noteCancellationProblem(pg: Pg, orderId: string, problem: string): Promise<void> {
  await pg.raw(
    `UPDATE order_dispatch
        SET last_error = ?, updated_at = now()
      WHERE order_id = ? AND state = 'cancelling' AND deleted_at IS NULL`,
    [problem.slice(0, 500), orderId]
  )
}

/**
 * Finds cancellations that started but never finished, which may have moved
 * money. They are flagged once (so staff are told once) and left for a person.
 */
export async function flagStalledCancellations(
  pg: Pg,
  stalledAfterMinutes: number
): Promise<string[]> {
  const result = await pg.raw(
    `UPDATE order_dispatch
        SET last_error = 'Cancellation was interrupted before it finished', updated_at = now()
      WHERE state = 'cancelling'
        AND deleted_at IS NULL
        AND last_error IS NULL
        AND updated_at < now() - (?::int * interval '1 minute')
      RETURNING order_id`,
    [stalledAfterMinutes]
  )
  return result.rows.map((row) => String(row.order_id))
}
