import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, generateEntityId } from "@medusajs/framework/utils"
import { codGstRate, goodsGstRate, goodsHsn, serviceSac } from "../../utils/tax-config"
import { seller, sellerProblems } from "../../utils/seller-config"
import { toPaise } from "../../utils/gst-math"
import { COD_PROVIDER_ID } from "../../utils/commerce-rules"
import { ORDER_DISPATCH_MODULE } from "../order-dispatch"
import type OrderDispatchModuleService from "../order-dispatch/service"
import type { Pg } from "../order-dispatch/transitions"
import { CREDIT_NOTE_MODULE } from "./index"
import type CreditNoteModuleService from "./service"
import { creditNotePrefix, financialYearLabel, formatCreditNoteNumber } from "./config"
import {
  COD_ITEM_ID,
  CreditNoteError,
  buildCreditNoteDocument,
  gstr1Period,
  istIso,
  type CreditNoteDocument,
  type CreditNoteKind,
  type OriginalLine,
  type PriorCredit,
} from "./document"

const num = (value: unknown): number => {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object") {
    const big = value as { numeric?: unknown; value?: unknown }
    if (big.numeric !== undefined) return Number(big.numeric)
    if (big.value !== undefined) return Number(big.value)
  }
  return Number.NaN
}

export type SavedCreditNote = {
  id: string
  credit_note_number: string
  fy: string
  source_key: string
  kind: CreditNoteKind
  order_id: string
  return_request_id: string | null
  original_invoice_number: string
  issued_at: Date
  total_paise: number
  deduction_paise: number
  net_credit_paise: number
  payload: CreditNoteDocument
  pdf_key: string | null
}

/**
 * Saves a credit note and gives it the next number of the financial year, in one
 * transaction: if anything fails nothing is kept and the number is not used, so
 * the series has no gaps. A note already saved for the same source is returned
 * as it is, and no second number is taken.
 */
export async function saveCreditNote(
  pg: Pg,
  input: {
    document: CreditNoteDocument
    kind: CreditNoteKind
    source_key: string
    order_id: string
    return_request_id: string | null
    issued_at: Date
    prefix: string
  }
): Promise<{ created: boolean; note: SavedCreditNote }> {
  const existing = async (db: Pg): Promise<SavedCreditNote | null> => {
    const found = await db.raw(`SELECT * FROM credit_note WHERE source_key = ? AND deleted_at IS NULL`, [input.source_key])
    return (found.rows[0] as SavedCreditNote | undefined) ?? null
  }

  const before = await existing(pg)
  if (before) return { created: false, note: before }

  const fy = financialYearLabel(input.issued_at)
  try {
    const note = await pg.transaction(async (trx) => {
      const counter = await trx.raw(
        `INSERT INTO credit_note_counter (id, fy, last_seq, created_at, updated_at)
              VALUES (?, ?, 1, now(), now())
         ON CONFLICT (fy) WHERE deleted_at IS NULL
           DO UPDATE SET last_seq = credit_note_counter.last_seq + 1, updated_at = now()
           RETURNING last_seq`,
        [generateEntityId(undefined, "crnc"), fy]
      )
      const seq = Number(counter.rows[0].last_seq)
      const number = formatCreditNoteNumber(input.prefix, fy, seq)
      const document: CreditNoteDocument = {
        ...input.document,
        credit_note_number: number,
        credit_note_date: istIso(input.issued_at),
      }
      const totals = document.totals
      const total = toPaise(totals.total)
      const deduction = toPaise(document.adjustments.reverse_logistics_fee_deduction)

      const inserted = await trx.raw(
        `INSERT INTO credit_note (
            id, credit_note_number, fy, seq, source_key, kind, order_id, return_request_id,
            original_invoice_number, original_invoice_date, issued_at, gstr1_period,
            taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, deduction_paise, net_credit_paise,
            payload, pdf_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 0, now(), now())
         RETURNING *`,
        [
          generateEntityId(undefined, "crn"),
          number,
          fy,
          seq,
          input.source_key,
          input.kind,
          input.order_id,
          input.return_request_id,
          document.original_invoice_number,
          document.original_invoice_date,
          input.issued_at,
          gstr1Period(input.issued_at),
          toPaise(totals.taxable_value),
          toPaise(totals.cgst),
          toPaise(totals.sgst),
          toPaise(totals.igst),
          total,
          deduction,
          total - deduction,
          JSON.stringify(document),
        ]
      )
      return inserted.rows[0] as SavedCreditNote
    })
    return { created: true, note }
  } catch (error) {
    // Two requests for the same source at once: the loser's number is rolled back and it takes the winner's note.
    if ((error as { code?: string }).code === "23505") {
      const winner = await existing(pg)
      if (winner) return { created: false, note: winner }
    }
    throw error
  }
}

type OrderRow = {
  id: string
  display_id: number
  email: string | null
  discount_total?: unknown
  shipping_total?: unknown
  items?: ({
    id: string
    title?: string | null
    variant_title?: string | null
    unit_price?: unknown
    quantity?: unknown
    detail?: { quantity?: unknown } | null
  } | null)[]
  shipping_address?: { first_name?: string | null; last_name?: string | null; province?: string | null } | null
  payment_collections?: ({ payments?: ({ captured_at?: unknown; provider_id?: string | null } | null)[] | null } | null)[] | null
  credit_lines?: ({ reference?: string | null; amount?: unknown } | null)[] | null
}

export type CreditNoteContext = {
  order: {
    id: string
    display_id: number
    discount_total: number
    cod_charge: number
    lines: OriginalLine[]
    nothing_paid: boolean
  }
  buyer: { name: string; state: string; gstin: string | null }
  invoice: { number: string; issued_at: Date }
  prior: PriorCredit[]
}

/** Everything a credit note needs from the order, its invoice, and the notes already issued on it. */
export async function loadCreditNoteContext(container: MedusaContainer, orderId: string): Promise<CreditNoteContext> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "discount_total",
      "shipping_total",
      "items.id",
      "items.title",
      "items.variant_title",
      "items.unit_price",
      "items.quantity",
      "items.detail.quantity",
      "shipping_address.first_name",
      "shipping_address.last_name",
      "shipping_address.province",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.provider_id",
      "credit_lines.reference",
      "credit_lines.amount",
    ],
    filters: { id: orderId },
  })
  const order = data[0] as unknown as OrderRow | undefined
  if (!order) throw new CreditNoteError(`Order ${orderId} was not found`)

  const dispatchService: OrderDispatchModuleService = container.resolve(ORDER_DISPATCH_MODULE)
  const [dispatch] = await dispatchService.listOrderDispatches({ order_id: orderId }, { take: 1 })
  if (!dispatch?.invoice_number || !dispatch.invoice_issued_at) {
    throw new CreditNoteError("The order has no tax invoice, so there is nothing to credit")
  }

  const lines: OriginalLine[] = (order.items ?? [])
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      item_id: item.id,
      title: item.title ?? "Item",
      variant_title: item.variant_title ?? null,
      quantity: num(item.detail?.quantity ?? item.quantity),
      unit_price: num(item.unit_price),
    }))
  if (lines.some((line) => !Number.isFinite(line.quantity) || !Number.isFinite(line.unit_price))) {
    throw new CreditNoteError("The order's items could not be read")
  }

  const service: CreditNoteModuleService = container.resolve(CREDIT_NOTE_MODULE)
  const earlier = await service.listCreditNotes({ order_id: orderId })
  const prior: PriorCredit[] = []
  for (const note of earlier) {
    const document = note.payload as unknown as CreditNoteDocument
    for (const line of document.line_items ?? []) {
      prior.push({
        item_id: line.item_id,
        quantity: line.quantity,
        net_paise: toPaise(line.total),
        taxable_paise: toPaise(line.taxable_value),
        cgst_paise: toPaise(line.cgst),
        sgst_paise: toPaise(line.sgst),
        igst_paise: toPaise(line.igst),
      })
    }
  }

  // Money was taken if the customer paid online, a payment was captured (Cash on Delivery,
  // once the cash is collected) or the wallet paid part of it. An online payment counts
  // even when Medusa has not recorded the capture yet: the order exists only because it was paid.
  const captured = (order.payment_collections ?? []).some((collection) =>
    (collection?.payments ?? []).some(
      (payment) => Boolean(payment?.captured_at) || (Boolean(payment?.provider_id) && payment?.provider_id !== COD_PROVIDER_ID)
    )
  )
  const walletPaid = (order.credit_lines ?? []).some((line) => line?.reference === "wallet" && (num(line.amount) || 0) > 0)

  const address = order.shipping_address
  return {
    order: {
      id: order.id,
      display_id: Number(order.display_id),
      discount_total: num(order.discount_total) || 0,
      cod_charge: num(order.shipping_total) || 0,
      lines,
      nothing_paid: !captured && !walletPaid,
    },
    buyer: {
      name: [address?.first_name, address?.last_name].filter(Boolean).join(" ") || order.email || "Customer",
      state: address?.province ?? "",
      gstin: null,
    },
    invoice: { number: dispatch.invoice_number, issued_at: new Date(dispatch.invoice_issued_at) },
    prior,
  }
}

/** Units of each line not yet credited. Lines with nothing left are left out. */
export function remainingUnits(context: CreditNoteContext): { item_id: string; quantity: number }[] {
  const result: { item_id: string; quantity: number }[] = []
  for (const line of context.order.lines) {
    if (line.unit_price === 0) continue
    const done = context.prior.filter((p) => p.item_id === line.item_id).reduce((sum, p) => sum + p.quantity, 0)
    const left = line.quantity - done
    if (left > 0) result.push({ item_id: line.item_id, quantity: left })
  }
  return result
}

export type IssueCreditNoteInput = {
  order_id: string
  kind: CreditNoteKind
  reason: string
  /** What caused the note, for example "return:retreq_..."; one note per source. */
  source_key: string
  return_request_id?: string | null
  /** Items and units to credit, or "all" for everything not yet credited. */
  returned: { item_id: string; quantity: number }[] | "all"
  reverse_cod: boolean
  /** Kept back from what the customer gets, in rupees. */
  deduction?: number
  issued_at?: Date
}

export type IssueCreditNoteResult = { status: "issued" | "exists"; note: SavedCreditNote }

/** Builds and saves a credit note. Refuses, without taking a number, when it would not be valid. */
export async function issueCreditNote(
  container: MedusaContainer,
  input: IssueCreditNoteInput
): Promise<IssueCreditNoteResult> {
  const problems = sellerProblems()
  if (problems.length) throw new CreditNoteError(problems.join(" "))

  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg
  const duplicate = await pg.raw(`SELECT * FROM credit_note WHERE source_key = ? AND deleted_at IS NULL`, [input.source_key])
  if (duplicate.rows[0]) return { status: "exists", note: duplicate.rows[0] as SavedCreditNote }

  const context = await loadCreditNoteContext(container, input.order_id)
  const returned = input.returned === "all" ? remainingUnits(context) : input.returned
  // The COD charge goes on at most one note.
  const codDone = context.prior.some((p) => p.item_id === COD_ITEM_ID)

  const document = buildCreditNoteDocument({
    kind: input.kind,
    reason: input.reason,
    order: context.order,
    buyer: context.buyer,
    seller: seller(),
    invoice: context.invoice,
    goods: { rate: goodsGstRate(), hsn: goodsHsn() },
    service: { rate: codGstRate(), sac: serviceSac() },
    returned,
    reverse_cod: input.reverse_cod && !codDone,
    deduction: input.deduction ?? 0,
    prior: context.prior,
    return_request_id: input.return_request_id ?? null,
  })

  const issuedAt = input.issued_at ?? new Date()
  const saved = await saveCreditNote(pg, {
    document,
    kind: input.kind,
    source_key: input.source_key,
    order_id: input.order_id,
    return_request_id: input.return_request_id ?? null,
    issued_at: issuedAt,
    prefix: creditNotePrefix(),
  })
  return { status: saved.created ? "issued" : "exists", note: saved.note }
}
