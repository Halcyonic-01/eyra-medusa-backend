import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { capturePaymentWorkflow, completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { getRefundGateway } from "../order-dispatch/refund-gateway"
import type { Pg } from "../order-dispatch/transitions"
import { recordRazorpayIds } from "../../utils/order-confirmation"
import { postToStorefront } from "../../utils/storefront"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { loadCartPaymentState } from "./check"
import { judgeLateAttempt, type LateDecision } from "./late-payment-rules"
import { fetchRazorpayOrderPayments } from "./razorpay-api"
import {
  RAZORPAY_PROVIDER_ID,
  paidTowardsOrder,
  sessionRazorpayOrderId,
  type PaymentSnapshotRecord,
  type RazorpayOrder,
  type RazorpayPayment,
  type SessionLike,
} from "./rules"
import type PaymentSnapshotModuleService from "./service"

/**
 * Finds and settles Razorpay payments taken on attempts that are no longer the
 * cart's current one (see late-payment-rules). Called before a cart completes,
 * from the webhook guard (through an event), when a new payment is opened and
 * by a job. Everything runs under the cart's checkout lock and is safe to
 * repeat: a payment is recovered into the order at most once and refunded at
 * most once.
 */

/** Shared with start-razorpay-checkout, so no new attempt opens while a cart is settled. */
export const checkoutLockKey = (cartId: string) => `razorpay-checkout:${cartId}`
export const LATE_PAYMENT_EVENT = "eyra.razorpay_late_payment"
/** Razorpay settles a UPI or netbanking approval well within this. */
export const LATE_LOOKBACK_HOURS = 72
const MAX_ATTEMPTS_PER_CART = 10
const MAX_REFUND_TRIES = 5
/** A recovery that has not become an order after this long needs a person. */
const RECOVERY_REVIEW_HOURS = 24
const LOCK_SECONDS = 120

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
type Snapshot = PaymentSnapshotRecord & { id: string; superseded_at?: Date | null }
type LateRow = {
  id: string
  cart_id: string
  razorpay_order_id: string
  razorpay_payment_id: string
  amount_paise: number
  status: "recovered" | "refunding" | "refunded" | "needs_review"
  order_id: string | null
  refund_attempts: number
  created_at: Date | string
}

export type SettleResult = {
  cart_id: string
  checked: number
  recovered: boolean
  order_id: string | null
  refunded: number
  refunding: number
  waiting: number
  review: number
}

const service = (container: MedusaContainer) => container.resolve(PAYMENT_SNAPSHOT_MODULE) as PaymentSnapshotModuleService
const logger = (container: MedusaContainer) => container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
const sinceLookback = () => new Date(Date.now() - LATE_LOOKBACK_HOURS * 60 * 60 * 1000)

async function cartAttempts(container: MedusaContainer, cartId: string): Promise<Snapshot[]> {
  const rows = await service(container).listPaymentPriceSnapshots(
    { cart_id: cartId, created_at: { $gte: sinceLookback() } },
    { order: { created_at: "DESC" }, take: MAX_ATTEMPTS_PER_CART }
  )
  return rows as unknown as Snapshot[]
}

async function lateRows(container: MedusaContainer, cartId: string): Promise<LateRow[]> {
  return (await service(container).listLateRazorpayPayments({ cart_id: cartId })) as unknown as LateRow[]
}

/** The order the cart became and every Razorpay order behind it (payments, sessions, recorded ids). */
export async function loadCartOrder(container: MedusaContainer, cartId: string): Promise<{ id: string; razorpay_order_ids: string[] } | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: links } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
  const orderId = (links[0] as { order_id?: string } | undefined)?.order_id
  if (!orderId) return null
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "metadata", "payment_collections.payments.data", "payment_collections.payment_sessions.data"],
    filters: { id: orderId },
  })
  const order = data[0] as any
  const ids = new Set<string>()
  const add = (value: unknown) => typeof value === "string" && value && ids.add(value)
  add(order?.metadata?.razorpay_order_id)
  for (const collection of order?.payment_collections ?? []) {
    for (const payment of collection?.payments ?? []) add(payment?.data?.razorpayOrder?.id)
    // A crash can leave an order whose payment is not recorded yet; its session still names it.
    for (const session of collection?.payment_sessions ?? []) add(session?.data?.razorpayOrder?.id)
  }
  return { id: orderId, razorpay_order_ids: [...ids] }
}

/**
 * Points the cart's current (unpaid) Razorpay session at the paid older attempt,
 * so Medusa completes the cart with the payment the customer actually made.
 * The Razorpay plugin's update keeps the given Razorpay order instead of
 * opening a new one. The attempt's snapshot then takes over the session.
 */
async function rebindSession(container: MedusaContainer, current: SessionLike, snapshot: Snapshot, razorpayOrder: RazorpayOrder) {
  const notes = { ...((razorpayOrder as { notes?: Record<string, unknown> }).notes ?? {}), medusa_payment_session_id: current.id }
  await container.resolve(Modules.PAYMENT).updatePaymentSession({
    id: current.id,
    amount: snapshot.amount_paise / 100,
    currency_code: snapshot.currency_code,
    data: { razorpayOrder: { ...razorpayOrder, notes } },
    context: { idempotency_key: current.id },
  } as never)
  await claimSession(container, snapshot, current.id)
}

/** Makes `snapshot` the one attempt holding `sessionId`; whoever held it steps aside first (unique index). */
async function claimSession(container: MedusaContainer, snapshot: Snapshot, sessionId: string) {
  const snapshots = service(container)
  const holders = (await snapshots.listPaymentPriceSnapshots({ payment_session_id: sessionId, superseded_at: null })) as unknown as Snapshot[]
  for (const holder of holders) {
    if (holder.id !== snapshot.id) await snapshots.updatePaymentPriceSnapshots({ id: holder.id, superseded_at: new Date() })
  }
  if (snapshot.payment_session_id !== sessionId || snapshot.superseded_at) {
    await snapshots.updatePaymentPriceSnapshots({ id: snapshot.id, payment_session_id: sessionId, superseded_at: null })
  }
}

async function alertOps(container: MedusaContainer, row: LateRow, kind: "refunded" | "needs_review", detail: string) {
  const sent = await postToStorefront(
    "/api/ops/notify",
    {
      type: "late_payment",
      outcome: kind,
      cart_id: row.cart_id,
      order_id: row.order_id,
      razorpay_order_id: row.razorpay_order_id,
      razorpay_payment_id: row.razorpay_payment_id,
      amount: row.amount_paise / 100,
      detail,
    },
    logger(container)
  )
  if (sent === "sent") await service(container).updateLateRazorpayPayments({ id: row.id, alerted_at: new Date() })
}

/** The row for a Razorpay payment, created once. A racing insert loses to the unique index and reads the winner. */
async function rowFor(
  container: MedusaContainer,
  snapshot: Snapshot,
  payment: RazorpayPayment,
  values: { status: LateRow["status"]; reason: string; order_id: string | null }
): Promise<LateRow> {
  const snapshots = service(container)
  const find = async () =>
    ((await snapshots.listLateRazorpayPayments({ razorpay_payment_id: payment.id }, { take: 1 })) as unknown as LateRow[])[0]
  const existing = await find()
  if (existing) return existing
  try {
    return (await snapshots.createLateRazorpayPayments({
      cart_id: snapshot.cart_id,
      snapshot_id: snapshot.id,
      razorpay_order_id: snapshot.razorpay_order_id,
      razorpay_payment_id: payment.id,
      amount_paise: Number(payment.amount),
      currency_code: snapshot.currency_code,
      ...values,
    })) as unknown as LateRow
  } catch (error) {
    const winner = await find()
    if (winner) return winner
    throw error
  }
}

/**
 * Refunds one late payment, once however often it is called: the refund is
 * tagged with the row id and Razorpay is searched for it before anything is
 * sent. Gives up to a person after repeated clear refusals. Called with the
 * cart locks held, and never refunds a payment the cart's order is paid with.
 */
async function refundRow(container: MedusaContainer, row: LateRow): Promise<LateRow["status"]> {
  if (row.status === "refunded" || row.status === "needs_review") return row.status
  const snapshots = service(container)
  const order = await loadCartOrder(container, row.cart_id)
  if (order?.razorpay_order_ids.includes(row.razorpay_order_id)) {
    await snapshots.updateLateRazorpayPayments({ id: row.id, status: "recovered", order_id: order.id, resolved_at: new Date() })
    logger(container).warn(`[late-payment] ${row.razorpay_payment_id} is the payment of order ${order.id}; not refunding it`)
    return "recovered"
  }
  if (!order) await unbindSessions(container, row.cart_id, row.razorpay_order_id)
  if (row.status !== "refunding") await snapshots.updateLateRazorpayPayments({ id: row.id, status: "refunding" })

  const result = await getRefundGateway().refund({
    order_id: row.order_id ?? row.cart_id,
    razorpay_payment_id: row.razorpay_payment_id,
    razorpay_order_id: row.razorpay_order_id,
    amount: row.amount_paise / 100,
    fee: 0,
    cancellation_id: row.id,
    since_ms: new Date(row.created_at).getTime(),
  })
  const attempts = (row.refund_attempts ?? 0) + 1
  if (result.ok) {
    await snapshots.updateLateRazorpayPayments({
      id: row.id,
      status: "refunded",
      refund_id: result.refund_id,
      refund_attempts: attempts,
      last_error: null,
      resolved_at: new Date(),
    })
    logger(container).warn(`[late-payment] refunded Razorpay payment ${row.razorpay_payment_id} of cart ${row.cart_id} (${row.amount_paise / 100})`)
    await alertOps(container, { ...row, status: "refunded" }, "refunded", "Refunded automatically.")
    return "refunded"
  }
  // An unclear answer is retried: the next call finds a refund that did go through.
  const giveUp = !result.may_have_moved_money && attempts >= MAX_REFUND_TRIES
  await snapshots.updateLateRazorpayPayments({
    id: row.id,
    status: giveUp ? "needs_review" : "refunding",
    refund_attempts: attempts,
    last_error: result.error.slice(0, 500),
  })
  logger(container).error(`[late-payment] refund of ${row.razorpay_payment_id} (cart ${row.cart_id}) not done: ${result.error}`)
  if (giveUp) await alertOps(container, { ...row, status: "needs_review" }, "needs_review", result.error)
  return giveUp ? "needs_review" : "refunding"
}

/** Settles one cart. Throws RazorpayUnavailableError when Razorpay cannot be asked; nothing is decided then. */
async function settleLocked(container: MedusaContainer, cartId: string, result: SettleResult, recheckAfterMinutes: number) {
  const attempts = await cartAttempts(container, cartId)
  const rows = await lateRows(container, cartId)
  if (!attempts.length && !rows.length) return

  // A refund already decided is finished first, never reconsidered.
  for (const row of rows.filter((r) => r.status === "refunding")) tally(result, await refundRow(container, row))

  const state = await loadCartPaymentState(container, cartId)
  if (!state) return
  let current = state.session
  const currentOrderId = () => (current?.provider_id === RAZORPAY_PROVIDER_ID ? sessionRazorpayOrderId(current) : null)

  // A rebind that stopped half-way: the attempt the session now pays must hold the session.
  const holder = attempts.find((a) => a.razorpay_order_id === currentOrderId())
  if (holder && current && (holder.payment_session_id !== current.id || holder.superseded_at)) {
    await claimSession(container, holder, current.id)
  }

  const order = await loadCartOrder(container, cartId)
  const others = attempts.filter((a) => a.razorpay_order_id !== currentOrderId())

  let currentPaid = 0
  const currentRazorpay = currentOrderId()
  if (!order && currentRazorpay && others.length) {
    const fetched = await fetchRazorpayOrderPayments(currentRazorpay)
    currentPaid = fetched.order ? paidTowardsOrder(fetched.order, fetched.payments) : 0
  }

  for (const attempt of others) {
    const mine = rows.filter((row) => row.razorpay_order_id === attempt.razorpay_order_id)
    if (mine.some((row) => row.status === "needs_review")) {
      result.review += 1
      continue
    }
    if (mine.some((row) => row.status === "refunding")) continue
    const checkedAt = (attempt as { late_checked_at?: Date | string | null }).late_checked_at
    if (recheckAfterMinutes && checkedAt && Date.now() - new Date(checkedAt).getTime() < recheckAfterMinutes * 60 * 1000) continue

    const fetched = await fetchRazorpayOrderPayments(attempt.razorpay_order_id)
    result.checked += 1
    await service(container).updatePaymentPriceSnapshots({ id: attempt.id, late_checked_at: new Date() })
    const decision: LateDecision = judgeLateAttempt({
      snapshot: attempt,
      razorpayOrder: fetched.order,
      payments: fetched.payments,
      cart: state.cart as never,
      currentSession: current,
      currentPaidPaise: currentPaid,
      order,
    })

    if (decision.action === "refund") {
      for (const payment of decision.payments) {
        const row = await rowFor(container, attempt, payment, { status: "refunding", reason: decision.reason, order_id: order?.id ?? null })
        if (row.status === "recovered") {
          // It was recovered, then the cart moved on without it (another payment, a changed cart).
          await service(container).updateLateRazorpayPayments({ id: row.id, status: "refunding", reason: decision.reason })
          row.status = "refunding"
        }
        tally(result, await refundRow(container, row))
      }
      continue
    }
    if (decision.action === "wait") {
      result.waiting += 1
      continue
    }
    if (decision.action === "recover" && current && fetched.order) {
      await rebindSession(container, current, attempt, fetched.order)
      for (const payment of fetched.payments.filter((p) => p.order_id === attempt.razorpay_order_id && p.status === "captured")) {
        await rowFor(container, attempt, payment, { status: "recovered", reason: "recovered", order_id: null })
      }
      logger(container).warn(`[late-payment] cart ${cartId}: session ${current.id} now completes with paid Razorpay order ${attempt.razorpay_order_id}`)
      result.recovered = true
      // Anything else paid for this cart now waits for this one to become the order.
      currentPaid = paidTowardsOrder(fetched.order, fetched.payments)
      current = { ...current, data: { razorpayOrder: fetched.order } }
      continue
    }
    if (decision.action === "none" && decision.reason === "in_order" && order) {
      for (const row of mine.filter((r) => r.status === "recovered" && !r.order_id)) {
        await service(container).updateLateRazorpayPayments({ id: row.id, order_id: order.id, resolved_at: new Date() })
      }
    }
  }
}

function tally(result: SettleResult, status: LateRow["status"]) {
  if (status === "refunded") result.refunded += 1
  else if (status === "refunding") result.refunding += 1
  else if (status === "needs_review") result.review += 1
}

/**
 * Recovered payments that are not an order yet: complete the cart now. If the
 * cart refuses (stock gone, cart changed), the payment goes back; any other
 * failure is retried, and a person is asked after a day.
 */
async function finishRecoveries(container: MedusaContainer, cartId: string, result: SettleResult) {
  const pending = (await lateRows(container, cartId)).filter((row) => row.status === "recovered" && !row.order_id)
  if (!pending.length) return

  const existing = await loadCartOrder(container, cartId)
  if (!existing) {
    const { result: completed, errors } = await completeCartWorkflow(container).run({ input: { id: cartId }, throwOnError: false })
    if (errors?.length) {
      const error = errors[0]?.error as { type?: string; message?: string } | undefined
      // The payment is confirmed paid, so an authorization failure means Razorpay trouble: retry, never refund.
      const refused =
        (error?.type === MedusaError.Types.NOT_ALLOWED || error?.type === MedusaError.Types.INVALID_DATA) &&
        !/not authorized/i.test(error?.message ?? "")
      logger(container).error(`[late-payment] cart ${cartId} could not be completed with its recovered payment: ${error?.message}`)
      if (refused) {
        await withCartLock(container, cartId, () => refundUnplaceable(container, cartId, error?.message ?? "refused", result))
      } else {
        await reviewStaleRecoveries(container, pending)
      }
      return
    }
    result.order_id = (completed as { id?: string } | undefined)?.id ?? null
  }

  const order = existing ?? (await loadCartOrder(container, cartId))
  if (!order) return
  result.order_id = order.id
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  for (const row of pending) {
    if (!order.razorpay_order_ids.includes(row.razorpay_order_id)) continue
    // Razorpay's capture notice was answered before the rebind and is not sent again, so record it here.
    if (!(await recordCapture(container, order.id, row))) continue
    await service(container).updateLateRazorpayPayments({ id: row.id, order_id: order.id, resolved_at: new Date() })
    // Same conditional write the storefront makes, so either may come first.
    await recordRazorpayIds(pg, order.id, row.razorpay_order_id, row.razorpay_payment_id).catch(() => false)
  }
}

/**
 * Records in Medusa that the recovered payment is captured. Razorpay captured
 * it already; the plugin's capture only captures payments still authorized, so
 * no money moves. False when it could not be recorded (retried next run).
 */
async function recordCapture(container: MedusaContainer, orderId: string, row: LateRow): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["payment_collections.payments.id", "payment_collections.payments.captured_at", "payment_collections.payments.data"],
    filters: { id: orderId },
  })
  const payments = ((data[0] as any)?.payment_collections ?? []).flatMap((c: any) => c?.payments ?? []).filter(Boolean)
  const payment = payments.find((p: any) => p.data?.razorpayOrder?.id === row.razorpay_order_id)
  if (!payment) return false
  if (payment.captured_at) return true
  const { errors } = await capturePaymentWorkflow(container).run({ input: { payment_id: payment.id }, throwOnError: false })
  if (errors?.length) {
    logger(container).error(`[late-payment] could not record the capture of ${row.razorpay_payment_id} on order ${orderId}: ${(errors[0].error as Error)?.message}`)
    return false
  }
  return true
}

/**
 * Before refunding a payment of an open cart: drop any session that points at
 * its Razorpay order. Razorpay still calls a refunded order "paid", so a later
 * completion must not be able to use it. The customer opens a new payment.
 */
async function unbindSessions(container: MedusaContainer, cartId: string, razorpayOrderId: string) {
  const state = await loadCartPaymentState(container, cartId)
  for (const session of state?.razorpaySessions ?? []) {
    if (sessionRazorpayOrderId(session) === razorpayOrderId) await container.resolve(Modules.PAYMENT).deletePaymentSession(session.id)
  }
}

/** Completion refused the recovered payment: refund it, unless the cart became an order meanwhile. */
async function refundUnplaceable(container: MedusaContainer, cartId: string, why: string, result: SettleResult) {
  if (await loadCartOrder(container, cartId)) return
  const owed = (await lateRows(container, cartId)).filter((r) => r.status === "recovered" && !r.order_id)
  for (const row of owed) {
    await service(container).updateLateRazorpayPayments({ id: row.id, status: "refunding", reason: `completion_refused: ${why}`.slice(0, 500) })
    tally(result, await refundRow(container, { ...row, status: "refunding" }))
  }
}

async function reviewStaleRecoveries(container: MedusaContainer, rows: LateRow[]) {
  const cutoff = Date.now() - RECOVERY_REVIEW_HOURS * 60 * 60 * 1000
  for (const row of rows) {
    if (new Date(row.created_at).getTime() > cutoff) continue
    await service(container).updateLateRazorpayPayments({ id: row.id, status: "needs_review", last_error: "recovered payment never became an order" })
    await alertOps(container, { ...row, status: "needs_review" }, "needs_review", "The payment was matched to the cart but the order could not be completed.")
  }
}

/** The checkout lock and Medusa's own cart-completion lock (keyed by the cart id), always in that order. */
function withCartLock<T>(container: MedusaContainer, cartId: string, job: () => Promise<T>): Promise<T> {
  return container.resolve(Modules.LOCKING).execute([checkoutLockKey(cartId), cartId], job, { timeout: LOCK_SECONDS })
}

/**
 * Settles every late payment of a cart. With `complete`, a recovered payment is
 * also turned into the order here; without it the caller is about to complete
 * the cart itself (the store complete route). `recheckAfterMinutes` lets the job
 * skip attempts it asked Razorpay about moments ago.
 */
export async function settleLatePayments(
  container: MedusaContainer,
  cartId: string,
  options: { complete: boolean; recheckAfterMinutes?: number }
): Promise<SettleResult> {
  const result: SettleResult = { cart_id: cartId, checked: 0, recovered: false, order_id: null, refunded: 0, refunding: 0, waiting: 0, review: 0 }
  await withCartLock(container, cartId, () => settleLocked(container, cartId, result, options.recheckAfterMinutes ?? 0))
  if (options.complete) await finishRecoveries(container, cartId, result)
  return result
}

/** Asks for a cart to be settled soon, without waiting (the webhook must answer quickly). */
export async function requestSettle(container: MedusaContainer, cartId: string) {
  await container.resolve(Modules.EVENT_BUS).emit({ name: LATE_PAYMENT_EVENT, data: { cart_id: cartId } })
}

/**
 * Whether money has been taken on any attempt of the cart, current or replaced,
 * that is not being given back. Opening another payment then is refused.
 * Throws RazorpayUnavailableError when Razorpay cannot be asked.
 */
export async function paidAttempts(
  container: MedusaContainer,
  cartId: string,
  sessions: SessionLike[]
): Promise<{ current: boolean; replaced: boolean }> {
  const returning = new Set(
    (await lateRows(container, cartId)).filter((row) => row.status !== "recovered").map((row) => row.razorpay_payment_id)
  )
  const currentIds = new Set(sessions.map((s) => sessionRazorpayOrderId(s)).filter((id): id is string => Boolean(id)))
  const ids = new Set([...currentIds, ...(await cartAttempts(container, cartId)).map((a) => a.razorpay_order_id)])
  const found = { current: false, replaced: false }
  for (const id of ids) {
    const { order, payments } = await fetchRazorpayOrderPayments(id)
    if (!order) continue
    const kept = payments.filter((payment) => !returning.has(payment.id))
    if (paidTowardsOrder(order, kept) > 0) found[currentIds.has(id) ? "current" : "replaced"] = true
  }
  return found
}
