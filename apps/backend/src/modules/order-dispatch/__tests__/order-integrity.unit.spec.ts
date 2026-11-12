import {
  CHECKOUT_MARKER,
  EMAIL_RETRY_MINUTES,
  missingReservations,
  nextEmailAttempt,
  orphanVerdict,
  type OrphanFacts,
} from "../order-integrity"

const now = new Date("2026-11-11T12:00:00Z")
const leftover = (over: Partial<OrphanFacts> = {}): OrphanFacts & { id: string } => ({
  id: "order_orphan",
  status: "pending",
  created_at: new Date(now.getTime() - 30 * 60 * 1000),
  metadata: { [CHECKOUT_MARKER]: "cart_1" },
  has_cart: false,
  payments: 0,
  wallet_redeemed: false,
  fulfillments: 0,
  dispatch_state: null,
  marked_cart_order_id: null,
  ...over,
})

describe("orphanVerdict", () => {
  it("voids a checkout leftover with nothing attached", () => {
    expect(orphanVerdict(leftover(), now)).toEqual({ void: true, cart_id: "cart_1" })
    expect(orphanVerdict(leftover({ marked_cart_order_id: "order_real" }), now)).toEqual({ void: true, cart_id: "cart_1" })
    expect(orphanVerdict(leftover({ dispatch_state: "placed" }), now).void).toBe(true)
  })

  it("never touches an order made in the admin (no checkout marker) or a replacement", () => {
    expect(orphanVerdict(leftover({ metadata: null }), now)).toMatchObject({ void: false, reason: "not_from_checkout" })
    expect(orphanVerdict(leftover({ metadata: { [CHECKOUT_MARKER]: 42 } }), now)).toMatchObject({ reason: "not_from_checkout" })
    expect(orphanVerdict(leftover({ metadata: { [CHECKOUT_MARKER]: "cart_1", replacement_for_order: "order_0" } }), now)).toMatchObject({ reason: "replacement" })
  })

  it("never voids anything with money, credit, stock movement or a courier behind it", () => {
    expect(orphanVerdict(leftover({ payments: 1 }), now)).toMatchObject({ reason: "has_payment" })
    expect(orphanVerdict(leftover({ wallet_redeemed: true }), now)).toMatchObject({ reason: "wallet_redeemed" })
    expect(orphanVerdict(leftover({ fulfillments: 1 }), now)).toMatchObject({ reason: "fulfilled" })
    expect(orphanVerdict(leftover({ dispatch_state: "shipped" }), now)).toMatchObject({ reason: "dispatch_shipped" })
    expect(orphanVerdict(leftover({ dispatch_state: "dispatching" }), now)).toMatchObject({ reason: "dispatch_dispatching" })
  })

  it("never voids the real order of the cart, or one linked to any cart", () => {
    expect(orphanVerdict(leftover({ has_cart: true }), now)).toMatchObject({ reason: "linked_to_cart" })
    expect(orphanVerdict(leftover({ marked_cart_order_id: "order_orphan" }), now)).toMatchObject({ reason: "linked_to_cart" })
  })

  it("waits until a completion that might still be running is long over", () => {
    expect(orphanVerdict(leftover({ created_at: new Date(now.getTime() - 5 * 60 * 1000) }), now)).toMatchObject({ reason: "too_recent" })
    expect(orphanVerdict(leftover({ status: "canceled" }), now)).toMatchObject({ reason: "already_canceled" })
  })

  it("skips the wait only for a caller holding the cart's completion lock, never the other checks", () => {
    const fresh = { created_at: new Date(now.getTime() - 60 * 1000) }
    expect(orphanVerdict(leftover(fresh), now, { cartLockHeld: true })).toEqual({ void: true, cart_id: "cart_1" })
    expect(orphanVerdict(leftover({ ...fresh, payments: 1 }), now, { cartLockHeld: true })).toMatchObject({ reason: "has_payment" })
    expect(orphanVerdict(leftover({ ...fresh, has_cart: true }), now, { cartLockHeld: true })).toMatchObject({ reason: "linked_to_cart" })
  })
})

describe("missingReservations", () => {
  const single = { inventory_item_id: "iitem_anklet", required_quantity: 1 }
  const pair = { inventory_item_id: "iitem_anklet", required_quantity: 2 }

  it("needs quantity times required quantity: a Pair takes two of the Single's stock", () => {
    const needs = missingReservations(
      [
        { id: "line_single", quantity: 1, manage_inventory: true, inventory_items: [single] },
        { id: "line_pair", quantity: 2, manage_inventory: true, inventory_items: [pair] },
      ],
      []
    )
    expect(needs).toEqual([
      { line_item_id: "line_single", inventory_item_id: "iitem_anklet", quantity: 1 },
      { line_item_id: "line_pair", inventory_item_id: "iitem_anklet", quantity: 4 },
    ])
  })

  it("only adds what is missing and never more", () => {
    const lines = [{ id: "line_pair", quantity: 2, manage_inventory: true, inventory_items: [pair] }]
    expect(missingReservations(lines, [{ line_item_id: "line_pair", inventory_item_id: "iitem_anklet", quantity: 4 }])).toEqual([])
    expect(missingReservations(lines, [{ line_item_id: "line_pair", inventory_item_id: "iitem_anklet", quantity: 1 }])).toEqual([
      { line_item_id: "line_pair", inventory_item_id: "iitem_anklet", quantity: 3 },
    ])
    expect(missingReservations(lines, [{ line_item_id: "line_pair", inventory_item_id: "iitem_anklet", quantity: 9 }])).toEqual([])
  })

  it("skips lines that do not track stock (the free tote may not)", () => {
    expect(missingReservations([{ id: "line_tote", quantity: 1, manage_inventory: false, inventory_items: [single] }], [])).toEqual([])
  })
})

describe("nextEmailAttempt", () => {
  it("backs off and then gives up", () => {
    expect(nextEmailAttempt(0, now)!.getTime() - now.getTime()).toBe(10 * 60 * 1000)
    expect(nextEmailAttempt(4, now)!.getTime() - now.getTime()).toBe(240 * 60 * 1000)
    expect(nextEmailAttempt(EMAIL_RETRY_MINUTES.length, now)).toBeNull()
  })
})
