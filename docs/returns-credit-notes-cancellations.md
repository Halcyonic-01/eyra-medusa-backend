# Cancellations, returns, exchanges and credit notes

How an order is cancelled, returned or exchanged, what the customer gets, and the
GST credit note that goes with it. It follows the two business documents
("Docs" and "Return, Exchange, and Cancellation Workflows"). The storefront half is
in its own repo's `docs/launch-commerce.md`.

## At a glance

| Where the order is | Customer can | Money | Tax document |
|---|---|---|---|
| Not shipped yet (held for the cancel window) | Cancel it, in their account | Everything paid online goes back to the card or bank it came from, nothing kept. Wallet credit used goes back to the wallet. | None. No invoice exists yet. |
| Shipped, not delivered | Not cancel. The parcel can be refused at the door. | When the parcel is back with us: paid online comes back, less the ₹99 reverse logistics fee. Cash on Delivery: nothing was paid. | Credit note, COD charge kept if delivery was attempted. |
| Delivered, within 15 days (7 for an exchange) | Return for store credit, or exchange (exchanges only in the first 7 days) | Return: store credit = what was paid for the item less ₹99 (no fee if damaged or defective), valid 12 months. No cash. Exchange: no fee; only a price difference, if the replacement costs more, by payment link. | Credit note for the item. |
| Delivered, after 7 days | Return only; exchanges are closed | Same as above for a return | Credit note for the item. |
| Delivered, after 15 days | Nothing | | |
| Staff cancel in the admin after it shipped | (staff action) | Medusa refunds what was captured | Credit note for everything, COD charge too unless delivery was attempted |

## Cancelling before it ships

- The order is held for `ORDER_CANCEL_WINDOW_MINUTES` before its shipment is made.
  Cancelling inside that window refunds **100%, nothing deducted**, to the payment
  method used (a Razorpay refund). There is no wallet-or-bank choice any more and
  no cancellation fee: `ORDER_CANCEL_FEE` is no longer read. A request to be
  refunded to the wallet instead is refused, not quietly changed.
- Once a shipment exists the order cannot be cancelled by the customer. The
  message says to refuse delivery, or to return it within 15 days after delivery (or exchange it within 7).
- A shipment can only exist after the cancel window closes, so no courier booking
  needs cancelling when a customer cancels; there is nothing to void and no invoice
  to reverse. The customer's cancellation never leaves an invoice behind.

## Shipped, then refused or undeliverable (RTO)

Shiprocket's tracking updates reach `POST /webhooks/shiprocket/order-update`
(directly, or forwarded by the storefront's `/api/tracking/webhook`, which already
receives them). Header `x-api-key` must equal `SHIPROCKET_WEBHOOK_SECRET`; with none
set the route is closed.

- OUT FOR DELIVERY, UNDELIVERED or DELIVERED records that delivery was attempted.
  DELIVERED also starts the 7-day window (`order_dispatch.delivered_at`).
- RTO DELIVERED (the parcel is back with us) issues a credit note for the goods,
  keeps the COD charge (the courier tried), keeps ₹99, and refunds the rest:
  what was paid online back to the card or bank, anything paid with wallet credit
  back to the wallet (12 months). A Cash on Delivery parcel refused at the door
  paid nothing, so there is nothing to refund. The team gets an email either way.
- `RTO_AUTO_REFUND=false` keeps the credit note but leaves the money for a person.
- Every part is safe to repeat: one credit note per order, the Razorpay refund is
  tagged and looked up before it is sent, the wallet credit has a reference.

## Returns (store credit)

1. **Asking.** The customer picks the item, a reason (`SIZE_ISSUE`,
   `DESIGN_PREFERENCE`, `DAMAGED_IN_TRANSIT`, `DEFECTIVE`) and sends it. Allowed
   only when the order was delivered, within 15 days of delivery for a return and 7 days for an exchange. The free tote
   cannot be returned. If delivery cannot be confirmed at all, the request is kept
   for the team (as before) and nothing is booked.
2. **Pickup.** The courier is booked at once (Shiprocket "create return order",
   made by the storefront: `POST /api/returns/reverse-pickup`). If that fails the
   request is kept as `pending` with the reason, the team is emailed, and
   **Retry pickup** in the admin books it.
3. **Arrival.** Shiprocket reports the reverse parcel DELIVERED: the request moves
   to `awaiting_inspection` and the team is emailed.
4. **Quality check.** Admin, Returns, **Mark received**. That announces the event
   `order.return_received`, and a handler then:
   - issues the credit note (one per request), draws and stores its PDF,
   - adds store credit = paid value − ₹99, valid 12 months,
   - marks the request completed, WhatsApps and emails the customer.
   Every step is idempotent. If one fails the team is emailed and a job
   (`finish-received-returns`, every 5 minutes) finishes it.
5. **Failing the check.** **Decline** with a reason; nothing is issued.

"What was paid" is the item's price after its share of the order's discount, GST
included. The ₹99 is charged once per return however many items.

## Exchanges

There is **no exchange fee**. An exchange starts directly.

1. **Asking.** One item, one unit, and the size or design wanted instead (it must
   be on sale, priced and in stock; the price is read from Medusa).
2. **Pickup.** If the replacement costs the same or less than what was paid for the
   item, nothing is due: the courier is booked at once, status
   `reverse_pickup_scheduled`, exactly like a return.
3. **Only if it costs more:** the backend makes a Razorpay payment link for the
   difference alone (status `pending_fee`; under ₹1 is not charged). If the link
   cannot be made the request is **not kept**, so nobody waits for a link that does
   not exist. `POST /webhooks/razorpay/payment-link-paid` (signature checked with
   `RAZORPAY_WEBHOOK_SECRET`; the event is `payment_link.paid`, and `payment.link.paid`
   is accepted too) books the courier once it is paid in full. A link paid short is
   not accepted and the team is told.
4. **Arrival and check.** As for a return. **Mark received** needs the difference
   paid, when there was one.
5. **Replacement.** A credit note reverses the old item (no fee). A new order is
   made for the replacement at the price agreed when asked, for the same customer
   and address, marked `replacement_for_order`, with its stock reserved, and shipped
   at once (no cancel window). The courier collects nothing: it is sent as prepaid.
   It gets its own tax invoice when it ships.
6. **Cheaper replacement.** The difference is added as store credit, 12 months.

(The database columns `fee_link_id`, `fee_link_url`, `fee_paid_at`, `fee_payment_id`
and `amount_due` keep their old names: they now hold the payment link for the
price difference.) An exchange waiting for a payment stays `pending_fee`; there is
no automatic expiry, the link stops working after 3 days. Decline the request to
close it.

## Credit notes

- **Numbering**: `CN/26-27/0001`, one series per financial year, taken in the same
  database transaction that saves the note, so a note that fails to save leaves
  no gap. One note per cause (`return:<request>`, `exchange:<request>`,
  `cancel:<order>`, `rto:<order>`): asking again returns the same note.
  Prefix: `CREDIT_NOTE_PREFIX` (default `CN`).
- **Content** (Rule 53): credit note number and date, original invoice number and
  date, seller (GSTIN) and customer (name, state, state code, optional GSTIN), the
  lines (HSN/SAC, taxable value, rate, CGST, SGST or IGST, total), and the
  adjustments (`reverse_logistics_fee_deduction`, `net_store_credit_issued`, and
  `net_refund_amount` for a refund). Nothing is issued without a valid
  `SELLER_GSTIN`; no number is taken in that case.
- **Which GST is reversed**
  - Goods: 3% (HSN 7113), taken out of each line's *net* value.
  - The discount was spread over the invoice lines before tax, so a returned line
    is reversed at its own net value. A line returned in parts is reversed in
    proportion, and the last unit takes whatever is left, so the notes for a line
    add up to the invoice line to the paisa.
  - COD charge: 18% (SAC 9997). Reversed in full, once, only for a cancellation
    after dispatch when delivery was never attempted. Kept after a return or a
    refused delivery.
  - The ₹99 reverse logistics fee (not charged for damaged or defective items) is
    deducted from what the customer gets and carries 18% GST (SAC 9997), shown on the
    note. An exchange has no fee.
- **PDF**: drawn by the storefront from the stored document (it recalculates
  nothing), kept as a **private** object at
  `credit-notes/FY26-27/<number>-<id>.pdf` in the S3 bucket
  (`CREDIT_NOTE_S3_PREFIX`, and optionally its own bucket `CREDIT_NOTE_S3_BUCKET`;
  with no S3, Medusa's file service as invoices do). The note is saved before its
  PDF is tried; a PDF that cannot be drawn is retried by `generate-credit-note-pdfs`.
- **GSTR-1**: `GET /admin/credit-notes/gstr1?month=2026-10` downloads the month's
  credit notes as CSV (seller and recipient GSTIN, credit note number, original
  invoice number, HSN/SAC, taxable value, CGST, SGST, IGST), one row per line. On the
  1st of each month `export-gstr1-credit-notes` also writes last month's file to
  the `gstr1/` folder.
- **Customers** download their credit notes from the order page. **Staff**:
  `GET /admin/credit-notes?order_id=...` and `/admin/credit-notes/:id/pdf`.

## The routes and webhooks

| Route | Who calls it | What it does |
|---|---|---|
| `POST /webhooks/shiprocket/order-update` | Shiprocket, or the storefront forwarding | delivery, window, RTO, reverse parcel arrived |
| `POST /webhooks/razorpay/payment-link-paid` | Razorpay | exchange price difference paid |
| `POST /webhooks/medusa/return-approved` | internal (`x-shipment-secret`) | runs the finish (credit note, PDF, credit or replacement) for one request again |
| `POST /admin/return-requests` | storefront | ask for a return or exchange |
| `POST /admin/return-requests/:id/received` | staff | passed the check |
| `POST /admin/return-requests/:id/retry-pickup` | staff | book the courier again |
| `POST /admin/return-requests/:id/approve` | staff | older requests: credit for an amount staff choose |
| `POST /admin/return-requests/:id/reject` | staff | decline, with a reason |
| `GET /admin/credit-notes` and `/gstr1`, `/:id/pdf` | staff, storefront | list, CSV, PDF |
| `POST /store/carts/:id/reconcile` | storefront | keeps the complimentary tote right |

## Settings

Backend: `SELLER_*` (the same as the storefront), `SHIPROCKET_WEBHOOK_SECRET`,
`JEWELRY_GST_RATE`, `JEWELRY_HSN_CODE`, `COD_GST_RATE`, `SERVICE_SAC_CODE`,
`CREDIT_NOTE_PREFIX`, `CREDIT_NOTE_S3_PREFIX`, `CREDIT_NOTE_S3_BUCKET`,
`RTO_AUTO_REFUND`, `TOTE_INITIAL_STOCK`, `WALLET_CREDIT_VALIDITY_MONTHS` (12).
Razorpay keys and webhook secret as before. Storefront: see its guide.

Add the Razorpay webhook event `payment_link.paid` for the URL
`https://<backend>/webhooks/razorpay/payment-link-paid`, with the same secret as
`RAZORPAY_WEBHOOK_SECRET`. (The plugin's own webhook is a different URL.)

## Decisions (confirmed by the owner unless marked)

1. **No cancellation fee.** An order cancelled within the 2-hour window is refunded
   in full. Set `ORDER_CANCEL_WINDOW_MINUTES=120` on **both** the backend and the
   storefront (the window is also how long an order is held; with 0 customers
   cannot cancel at all).
2. **COD charge: 18% GST (SAC 9997).**
3. **No reverse logistics fee for a damaged or defective item** (reasons
   `DAMAGED_IN_TRANSIT` and `DEFECTIVE`): the whole paid value comes back as credit.
   The ₹99 is still kept for `SIZE_ISSUE` and `DESIGN_PREFERENCE`.
4. **A refused parcel is refunded automatically** to the original payment, less
   ₹99 (switchable with `RTO_AUTO_REFUND`). Cash on Delivery refusals refund nothing.
5. **Store credit goes straight to the wallet**, valid 12 months. No separate code.
6. **18% GST on the return fee.** The ₹99 includes it (taxable ₹83.90 + GST ₹15.10,
   split 9% + 9% or IGST 18%). It is shown on the credit note (rows under the credit,
   and `adjustments.fee` in the stored document) and exported as its own row in the
   GSTR-1 CSV (Row Type "Fee retained"). The same applies to the ₹99 kept from a
   refused parcel.
7. **No exchange fee.** An exchange starts directly. Only a price difference, when
   the replacement costs more, is paid, by payment link.
   **No separate tax invoice is issued for the fee.** As on other shops, the fee
   is itemised with its GST in the refund breakup, here the credit note. Its
   figures are stored (`adjustments.fee`), so a separate service invoice can be added
   later without losing anything if the accountant asks for one.

Still my choice, please confirm:

- **Cheaper exchange**: the difference comes back as store credit, 12 months.
- **Medusa tax rates**: the two rates exist in Medusa's tax module but automatic
  taxes are off on the region, because Medusa would otherwise report the items
  subtotal without tax, which the discount thresholds read. Invoices and credit
  notes work the GST out from the inclusive amounts.
- **The tote** is a real ₹0 product, hidden from the shop. It goes to Shiprocket at
  ₹0; if Shiprocket rejects that set `SHIPROCKET_FREE_GIFT_PRICE=one_rupee`.
- **The unboxing video** is policy wording only; there is no upload.
- **The checkout checkbox** keeps the business's fixed wording. Beneath it, as on
  other shops, a short note says there is no fee for a damaged or defective item and
  that the ₹99 includes 18% GST, with a link to the full return policy.

## What was tested, and what was not

Tested with in-process stand-ins (unit and integration tests): the GST sums, the
credit note builder and numbering (including concurrent requests and no gaps), the
PDF flow and its retries, the CSV, the Shiprocket updates and the refused-parcel
refund, the return and exchange rules, the payment link webhook (signatures, short
payment, repeats), the replacement order, cancellation refunds, and the idempotency
of every step.

**Not tested live**, because it needs real accounts: a real Shiprocket return order
and AWB (the request shape follows Shiprocket's documentation and has never been
sent), real Razorpay payment links and webhooks, WATI or AiSensy messages (and the
templates must be approved first), a real S3 or R2 bucket for `credit-notes/` and
`gstr1/`, and the first refund of a refused parcel. Try one of each before relying
on it.

## Not built

- Putting a returned item back into stock: do it by hand in Inventory.
- An automatic expiry for an exchange nobody paid for.
- Refunding a price difference that was paid on an exchange that is then declined: do
  it in the Razorpay dashboard.
- A restocking or damage deduction on a returned item (the documents say none).
