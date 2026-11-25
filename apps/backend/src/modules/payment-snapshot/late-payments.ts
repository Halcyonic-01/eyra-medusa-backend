import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { capturePaymentWorkflow, completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { getRefundGateway } from "../order-dispatch/refund-gateway"
import type { Pg } from "../order-dispatch/transitions"
import { recordRazorpayIds } from "../../utils/order-confirmation"
import { postToStorefront } from "../../utils/storefront"
import { PAYMENT_SNAPSHOT_MODULE } from "."
import { loadCartPaymentState } from "./check"
import {
  RAZORPAY_PROVIDER_ID,
  checkoutLockKey,
  getGateway,
  ownPayments,
  paidTowardsAttempt,
  sessionAttempt,
  type GatewayAttempt,
  type GatewayPayment,
} from "./gateways"
import { judgeLateAttempt, type LateDecision } from "./late-payment-rules"
import { attemptAmountPaise, attemptRef, type PaymentSnapshotRecord, type SessionLike } from "./rules"
import type PaymentSnapshotModuleService from "./service"

/**
 * Finds and settles payments taken on online attempts that are no longer the
 * cart's current one (see late-payment-rules), whichever provider each attempt
 * is with: every provider question goes through that attempt's gateway.
 * Called before a cart completes, from a provider's webhook guard (through an
 * event), when a new payment is opened and by a job. Everything runs under the
 * cart's checkout lock and is safe to repeat: a payment is recovered into the
 * order at most once and refunded at most once.
 */

export { checkoutLockKey }
export const LATE_PAYMENT_EVENT = "eyra.razorpay_late_payment"
/** Providers settle a UPI or netbanking approval well within this. */
export const LATE_LOOKBACK_HOURS = 72
const MAX_ATTEMPTS_PER_CART = 10
const MAX_REFUND_TRIES = 5
/** A recovery that has not become an order after this long needs a person. */
const RECOVERY_REVIEW_HOURS = 24
const LOCK_SECONDS = 120

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
type Snapshot = PaymentSnapshotRecord & { id: string; superseded_at?: Date | null; late_checked_at?: Date | string | null }
export type LateRow = {
  id: string
  cart_id: string
  provider_id: string
  provider_ref: string | null
  provider_payment_ref: string | null
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  amount_paise: number
  status: "recovered" | "refunding" | "refunded" | "needs_review"
  order_id: string | null
  refund_attempts: number
  created_at: Date | string
}

/** The attempt and payment of a row; rows from before the provider columns only have the Razorpay ones. */
const rowRef = (row: LateRow) => row.provider_ref ?? row.razorpay_order_id ?? ""
const rowPaymentRef = (row: LateRow) => row.provider_payment_ref ?? row.razorpay_payment_id ?? ""

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

const sameAttempt = (a: { provider_id?: string | null }, aRef: string | null, b: { provider_id?: string | null }, bRef: string | null) =>
  Boolean(aRef) && a.provider_id === b.provider_id && aRef === bRef

/** The order the cart became and every attempt behind it (payments, sessions, recorded Razorpay ids). */
export async function loadCartOrder(container: MedusaContainer, cartId: string): Promise<{ id: string; attempt_refs: string[] } | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: links } = await query.graph({ entity: "order_cart", fields: ["order_id"], filters: { cart_id: cartId } })
  const orderId = (links[0] as { order_id?: string } | undefined)?.order_id
  if (!orderId) return null
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "metadata",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.data",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.data",
    ],
    filters: { id: orderId },
  })
  const order = data[0] as any
  const refs = new Set<string>()
  const add = (value: unknown) => typeof value === "string" && value && refs.add(value)
  add(order?.metadata?.razorpay_order_id)
  for (const collection of order?.payment_collections ?? []) {
    for (const payment of collection?.payments ?? []) add(sessionAttempt(payment).ref)
    // A crash can leave an order whose payment is not recorded yet; its session still names it.
    for (const session of collection?.payment_sessions ?? []) add(sessionAttempt(session).ref)
  }
  return { id: orderId, attempt_refs: [...refs] }
}

/**
 * Points the cart's current (unpaid) session at the paid older attempt of the
 * same provider, so Medusa completes the cart with the payment the customer
 * actually made. The attempt's snapshot then takes over the session.
 */
async function rebindSession(container: MedusaContainer, current: SessionLike, snapshot: Snapshot, attempt: GatewayAttempt) {
  const gateway = getGateway(snapshot.provider_id)
  if (!gateway) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `No gateway for ${snapshot.provider_id}`)
  await gateway.rebindSession(container, current, attempt, snapshot.amount_paise / 100, snapshot.currency_code)
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

export async function alertOps(container: MedusaContainer, row: LateRow, kind: "refunded" | "needs_review", detail: string) {
  const razorpay = row.provider_id === RAZORPAY_PROVIDER_ID
  const sent = await postToStorefront(
    "/api/ops/notify",
    {
      type: "late_payment",
      outcome: kind,
      cart_id: row.cart_id,
      order_id: row.order_id,
      provider_id: row.provider_id,
      provider_ref: rowRef(row),
      provider_payment_ref: rowPaymentRef(row),
      // The storefront's alert reads these names.
      razorpay_order_id: razorpay ? rowRef(row) : null,
      razorpay_payment_id: razorpay ? rowPaymentRef(row) : null,
      amount: row.amount_paise / 100,
      detail,
    },
    logger(container)
  )
  if (sent === "sent") await service(container).updateLateRazorpayPayments({ id: row.id, alerted_at: new Date() })
}

/** The row for a provider payment, created once. A racing insert loses to the unique index and reads the winner. */
async function rowFor(
  container: MedusaContainer,
  snapshot: Snapshot,
  payment: GatewayPayment,
  values: { status: LateRow["status"]; reason: string; order_id: string | null }
): Promise<LateRow> {
  const snapshots = service(container)
  const razorpay = snapshot.provider_id === RAZORPAY_PROVIDER_ID
  const find = async () => {
    const [row] = (await snapshots.listLateRazorpayPayments(
      { provider_id: snapshot.provider_id, provider_payment_ref: payment.id },
      { take: 1 }
    )) as unknown as LateRow[]
    if (row || !razorpay) return row
    // Written before the provider columns existed.
    return ((await snapshots.listLateRazorpayPayments({ razorpay_payment_id: payment.id }, { take: 1 })) as unknown as LateRow[])[0]
  }
  const existing = await find()
  if (existing) return existing
  try {
    return (await snapshots.createLateRazorpayPayments({
      cart_id: snapshot.cart_id,
      snapshot_id: snapshot.id,
      provider_id: snapshot.provider_id,
      provider_ref: attemptRef(snapshot),
      provider_payment_ref: payment.id,
      razorpay_order_id: razorpay ? attemptRef(snapshot) : null,
      razorpay_payment_id: razorpay ? payment.id : null,
      amount_paise: Number(payment.amount_paise),
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
 * Before refunding a payment of an open cart: drop any session that points at
 * its attempt. A provider can still call a refunded attempt "paid" (Razorpay
 * does), so a later completion must not be able to use it. The customer opens
 * a new payment.
 */
async function unbindSessions(container: MedusaContainer, row: LateRow) {
  const state = await loadCartPaymentState(container, row.cart_id)
  for (const session of state?.prepaidSessions ?? []) {
    const { ref } = sessionAttempt(session)
    if (session.provider_id === row.provider_id && ref === rowRef(row)) {
      await container.resolve(Modules.PAYMENT).deletePaymentSession(session.id)
    }
  }
}

/**
 * Refunds one late payment through its provider, once however often it is
 * called: the refund is tagged with the row id and the provider is searched
 * for it before anything is sent. Gives up to a person after repeated clear
 * refusals. Called with the cart locks held, and never refunds a payment the
 * cart's order is paid with.
 */
async function refundRow(container: MedusaContainer, row: LateRow): Promise<LateRow["status"]> {
  if (row.status === "refunded" || row.status === "needs_review") return row.status
  const snapshots = service(container)
  const order = await loadCartOrder(container, row.cart_id)
  if (order?.attempt_refs.includes(rowRef(row))) {
    await snapshots.updateLateRazorpayPayments({ id: row.id, status: "recovered", order_id: order.id, resolved_at: new Date() })
    logger(container).warn(`[late-payment] ${rowPaymentRef(row)} is the payment of order ${order.id}; not refunding it`)
    return "recovered"
  }
  if (!order) await unbindSessions(container, row)
  if (row.status !== "refunding") await snapshots.updateLateRazorpayPayments({ id: row.id, status: "refunding" })

  const result = await getRefundGateway(row.provider_id).refund({
    order_id: row.order_id ?? row.cart_id,
    payment_ref: rowPaymentRef(row),
    attempt_ref: rowRef(row),
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
      // A new refund (or a re-sent one): followed again from the start until paid out.
      refund_verified_at: null,
      refund_checked_at: null,
    })
    logger(container).warn(`[late-payment] refunded ${row.provider_id} payment ${rowPaymentRef(row)} of cart ${row.cart_id} (${row.amount_paise / 100})`)
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
  logger(container).error(`[late-payment] refund of ${rowPaymentRef(row)} (cart ${row.cart_id}) not done: ${result.error}`)
  if (giveUp) await alertOps(container, { ...row, status: "needs_review" }, "needs_review", result.error)
  return giveUp ? "needs_review" : "refunding"
}

/** Settles one cart. Throws GatewayUnavailableError when a provider cannot be asked; nothing is decided for it then. */
async function settleLocked(container: MedusaContainer, cartId: string, result: SettleResult, recheckAfterMinutes: number) {
  const attempts = await cartAttempts(container, cartId)
  const rows = await lateRows(container, cartId)
  if (!attempts.length && !rows.length) return

  // A refund already decided is finished first, never reconsidered.
  for (const row of rows.filter((r) => r.status === "refunding")) tally(result, await refundRow(container, row))

  const state = await loadCartPaymentState(container, cartId)
  if (!state) return
  const current = state.session
  const currentGateway = sessionAttempt(current).gateway
  let currentRef = sessionAttempt(current).ref

  // A rebind that stopped half-way: the attempt the session now pays must hold the session.
  const holder = current ? attempts.find((a) => sameAttempt(a, attemptRef(a), current, currentRef)) : undefined
  if (holder && current && (holder.payment_session_id !== current.id || holder.superseded_at)) {
    await claimSession(container, holder, current.id)
  }

  const order = await loadCartOrder(container, cartId)
  const others = attempts.filter((a) => !current || !sameAttempt(a, attemptRef(a), current, currentRef))

  let currentPaid = 0
  if (!order && currentGateway && currentRef && others.length) {
    const fetched = await currentGateway.fetchAttempt(currentRef)
    currentPaid = fetched ? paidTowardsAttempt(fetched) : 0
  }

  for (const attempt of others) {
    const ref = attemptRef(attempt)
    const mine = rows.filter((row) => row.provider_id === attempt.provider_id && rowRef(row) === ref)
    if (mine.some((row) => row.status === "needs_review")) {
      result.review += 1
      continue
    }
    if (mine.some((row) => row.status === "refunding")) continue
    const checkedAt = attempt.late_checked_at
    if (recheckAfterMinutes && checkedAt && Date.now() - new Date(checkedAt).getTime() < recheckAfterMinutes * 60 * 1000) continue
    const gateway = getGateway(attempt.provider_id)
    if (!gateway) {
      logger(container).error(`[late-payment] cart ${cartId}: no gateway for ${attempt.provider_id}, attempt ${ref} cannot be checked`)
      continue
    }

    const fetched = await gateway.fetchAttempt(ref)
    result.checked += 1
    await service(container).updatePaymentPriceSnapshots({ id: attempt.id, late_checked_at: new Date() })
    const decision: LateDecision = judgeLateAttempt({
      snapshot: attempt,
      attempt: fetched,
      cart: state.cart as never,
      currentSession: current,
      currentSessionRef: currentRef,
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
    if (decision.action === "recover" && current && fetched) {
      await rebindSession(container, current, attempt, fetched)
      for (const payment of fetched.payments.filter((p) => p.attempt_ref === ref && p.status === "captured")) {
        await rowFor(container, attempt, payment, { status: "recovered", reason: "recovered", order_id: null })
      }
      logger(container).warn(`[late-payment] cart ${cartId}: session ${current.id} now completes with paid ${attempt.provider_id} attempt ${ref}`)
      result.recovered = true
      // Anything else paid for this cart now waits for this one to become the order.
      currentPaid = paidTowardsAttempt(fetched)
      currentRef = ref
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
      // The payment is confirmed paid, so an authorization failure means provider trouble: retry, never refund.
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
    if (!order.attempt_refs.includes(rowRef(row))) continue
    // The provider's capture notice was answered before the rebind and is not sent again, so record it here.
    if (!(await recordCapture(container, order.id, row))) continue
    await service(container).updateLateRazorpayPayments({ id: row.id, order_id: order.id, resolved_at: new Date() })
    if (row.provider_id === RAZORPAY_PROVIDER_ID) {
      // Same conditional write the storefront makes, so either may come first.
      await recordRazorpayIds(pg, order.id, rowRef(row), rowPaymentRef(row)).catch(() => false)
    }
  }
}

/**
 * Records in Medusa that the recovered payment is captured. The provider
 * captured it already; Razorpay's plugin only captures payments still
 * authorized, so no money moves. False when it could not be recorded (retried
 * next run).
 */
async function recordCapture(container: MedusaContainer, orderId: string, row: LateRow): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.data",
    ],
    filters: { id: orderId },
  })
  const payments = ((data[0] as any)?.payment_collections ?? []).flatMap((c: any) => c?.payments ?? []).filter(Boolean)
  const payment = payments.find((p: any) => p.provider_id === row.provider_id && sessionAttempt(p).ref === rowRef(row))
  if (!payment) return false
  if (payment.captured_at) return true
  const { errors } = await capturePaymentWorkflow(container).run({ input: { payment_id: payment.id }, throwOnError: false })
  if (errors?.length) {
    logger(container).error(`[late-payment] could not record the capture of ${rowPaymentRef(row)} on order ${orderId}: ${(errors[0].error as Error)?.message}`)
    return false
  }
  return true
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

export type MissedPaymentOutcome = "adopted" | "authorized" | "ordered" | "not_current" | "pending" | "not_paid" | "mismatch"

/**
 * A payment on the cart's current attempt that nothing confirmed: no webhook,
 * no return to the site, no completion. Under the cart's locks, and only while
 * the cart is not an order and the attempt is still its current one, each
 * captured payment is recorded as recovered; finishRecoveries then completes
 * the cart with it, or refunds it if the cart refuses. A payment that is held
 * but not captured is left to the caller to complete. Amounts that do not
 * match the attempt go to a person. Throws GatewayUnavailableError when the
 * provider cannot be asked; nothing is recorded then.
 */
export async function adoptMissedPayment(container: MedusaContainer, cartId: string, snapshotId: string): Promise<MissedPaymentOutcome> {
  return withCartLock(container, cartId, async () => {
    if (await loadCartOrder(container, cartId)) return "ordered"
    const snapshot = (await cartAttempts(container, cartId)).find((a) => a.id === snapshotId)
    const state = await loadCartPaymentState(container, cartId)
    const current = state?.session ?? null
    if (!snapshot || snapshot.superseded_at || !current || !sameAttempt(snapshot, attemptRef(snapshot), current, sessionAttempt(current).ref)) {
      return "not_current"
    }
    const gateway = getGateway(snapshot.provider_id)
    if (!gateway) return "not_current"
    const fetched = await gateway.fetchAttempt(attemptRef(snapshot))
    if (!fetched) return "not_paid"
    const own = ownPayments(fetched)
    const paid = paidTowardsAttempt(fetched)
    if (!paid) return own.some((p) => p.status === "pending") ? "pending" : "not_paid"

    const captured = own.filter((p) => p.status === "captured")
    if (paid !== attemptAmountPaise(snapshot)) {
      for (const payment of captured) {
        const row = await rowFor(container, snapshot, payment, { status: "needs_review", reason: "amount_mismatch", order_id: null })
        if (row.status === "needs_review" && !(row as { alerted_at?: Date | null }).alerted_at) {
          await alertOps(container, row, "needs_review", `Paid ${paid / 100} towards an attempt of ${attemptAmountPaise(snapshot) / 100}.`)
        }
      }
      logger(container).error(`[missed-payment] cart ${cartId}: ${snapshot.provider_id} attempt ${attemptRef(snapshot)} paid ${paid} paise, expected ${attemptAmountPaise(snapshot)}`)
      return "mismatch"
    }
    if (!captured.length) return "authorized"
    for (const payment of captured) {
      await rowFor(container, snapshot, payment, { status: "recovered", reason: "missed_confirmation", order_id: null })
    }
    logger(container).warn(`[missed-payment] cart ${cartId}: ${snapshot.provider_id} attempt ${attemptRef(snapshot)} was paid but never confirmed; completing it`)
    return "adopted"
  })
}

/**
 * Settles every late payment of a cart. With `complete`, a recovered payment is
 * also turned into the order here; without it the caller is about to complete
 * the cart itself (the store complete route). `recheckAfterMinutes` lets the job
 * skip attempts it asked the provider about moments ago.
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

/** Asks for a cart to be settled soon, without waiting (a webhook must answer quickly). */
export async function requestSettle(container: MedusaContainer, cartId: string) {
  await container.resolve(Modules.EVENT_BUS).emit({ name: LATE_PAYMENT_EVENT, data: { cart_id: cartId } })
}

/**
 * Whether money has been taken on any attempt of the cart, current or replaced,
 * on any provider, that is not being given back (opening another payment is
 * then refused), and which providers still have a payment in progress (one
 * that may yet succeed). Throws GatewayUnavailableError when a provider cannot
 * be asked, so an uncertain answer is never read as "unpaid".
 */
export type PendingPayment = { provider_id: string; ref: string; current: boolean; since: Date }

export type PaidAttempts = {
  current: boolean
  replaced: boolean
  pending_providers: string[]
  /** Payments still in progress at a provider, with when their attempt was opened. */
  pending: PendingPayment[]
  /** The provider money was taken with, when any. */
  paid_provider: string | null
}

export async function paidAttempts(
  container: MedusaContainer,
  cartId: string,
  sessions: SessionLike[]
): Promise<PaidAttempts> {
  const key = (providerId: string | null | undefined, ref: string) => `${providerId ?? ""}|${ref}`
  const returning = new Set(
    (await lateRows(container, cartId)).filter((row) => row.status !== "recovered").map((row) => key(row.provider_id, rowPaymentRef(row)))
  )
  const attempts = await cartAttempts(container, cartId)
  const openedAt = new Map(attempts.map((a) => [key(a.provider_id, attemptRef(a)), new Date((a as { created_at?: Date | string }).created_at ?? Date.now())]))
  const targets = new Map<string, { provider_id: string; ref: string; current: boolean }>()
  for (const session of sessions) {
    const { ref } = sessionAttempt(session)
    if (ref && session.provider_id) targets.set(key(session.provider_id, ref), { provider_id: session.provider_id, ref, current: true })
  }
  for (const attempt of attempts) {
    const ref = attemptRef(attempt)
    if (ref && !targets.has(key(attempt.provider_id, ref))) targets.set(key(attempt.provider_id, ref), { provider_id: attempt.provider_id, ref, current: false })
  }

  const found: PaidAttempts = { current: false, replaced: false, pending_providers: [], pending: [], paid_provider: null }
  for (const target of targets.values()) {
    const gateway = getGateway(target.provider_id)
    if (!gateway) continue
    const attempt = await gateway.fetchAttempt(target.ref)
    if (!attempt) continue
    const kept = { ...attempt, payments: attempt.payments.filter((p) => !returning.has(key(target.provider_id, p.id))) }
    if (paidTowardsAttempt(kept) > 0) {
      found[target.current ? "current" : "replaced"] = true
      found.paid_provider ??= target.provider_id
    }
    if (kept.payments.some((p) => p.attempt_ref === attempt.ref && p.status === "pending")) {
      if (!found.pending_providers.includes(target.provider_id)) found.pending_providers.push(target.provider_id)
      found.pending.push({
        provider_id: target.provider_id,
        ref: target.ref,
        current: target.current,
        since: openedAt.get(key(target.provider_id, target.ref)) ?? new Date(),
      })
    }
  }
  return found
}
