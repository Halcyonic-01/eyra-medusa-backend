# Launch commerce: setup and how it works

This covers the launch checkout rules, product options, S3 file storage, invoice
PDFs and the Shiprocket settings. Returns, exchanges, cancellations and credit
notes are in `docs/returns-credit-notes-cancellations.md`. The storefront half is
in its own repo's `docs/launch-commerce.md`. Run `npx medusa db:migrate` on deploy:
the credit notes, the delivery tracking and the new return request fields have
migrations.

## What changed, in one paragraph

Prepaid orders ship free and Cash on Delivery adds a flat charge, both set by
the backend. Three discount codes work through Medusa promotions. Anklets can be
sold as Single or Pair (a Pair is two of the same design at ₹200 less, drawing
two of the Single's stock) and pendants with or without a chain, as ordinary
Medusa variants priced in Medusa. Product prices include 3%
GST, and the invoice takes the GST out of the discounted price (the discount is
spread over the lines first). The Cash on Delivery charge carries 18% GST under
SAC 9997. Product images and invoice PDFs live in S3. Each shipped order gets a
real GST tax invoice PDF, stored once. A complimentary tote bag is added to
orders above ₹1,499 while in stock, as a real product at a price of zero.

## The rules, and where each is enforced

| Rule | Where it is set | Where it is enforced |
|---|---|---|
| Prepaid ships free, no minimum | shipping option `eyra-prepaid` (₹0) | cart payment mode route; completion check |
| COD adds ₹99, once | shipping option `eyra-cod` (₹99) | same; the option replaces the old one, so it cannot stack |
| WELCOME200: ₹200 off, orders above ₹1,499, no upper limit, once per account | Medusa promotion | Medusa rules on `item_subtotal`, plus a per-customer budget |
| EYRA350: ₹350 off, orders above ₹3,000, no upper limit, reusable | Medusa promotion | Medusa rules |
| EYRA650: ₹650 off, orders above ₹5,000, no upper limit, reusable | Medusa promotion | Medusa rules |
| One code per order | replace, not add | the discount route replaces; the completion check refuses two. A large order fits several codes, so the customer picks one |
| Complimentary tote above ₹1,499, one per order, while in stock | product `eyra-complimentary-tote` at ₹0 | the `reconcile` route adds and removes it; the completion check refuses a tote on a smaller order or two |

Each code is judged on its own minimum only, with no upper limit, so the
ranges overlap: a ₹6,000 order may use any one of the three. Every minimum is
"above", so exactly ₹1,499, ₹3,000 and ₹5,000 do not qualify, and the first rupee
above does. The thresholds are judged on the price of the items before any
discount and without shipping (`item_subtotal`), so applying a code never makes
the order stop qualifying for it.

A database set up earlier keeps the rules it was made with. Run
`npx medusa exec ./src/scripts/setup-launch-commerce.ts` again after deploying:
it brings the rules of the existing codes up to date (it removes the old upper
limits) and leaves everything else alone.

The single source for these numbers is `apps/backend/src/utils/commerce-rules.ts`.
The setup script builds the Medusa records from it, and the completion check
reads it. The storefront shows them from `config/offers.ts`. If an offer changes,
change both files and re-run the setup (it only creates what is missing, so
edit an existing promotion in the admin, or delete it and re-run).

### The completion check

`src/workflows/hooks/complete-cart-validate.ts` runs just before a cart becomes
an order, for every caller, including anyone calling Medusa directly:

- COD session: exactly one shipping method, the COD charge. Prepaid: exactly one,
  the free option. A cart wallet credit covers in full counts as prepaid.
- At most one discount code, and it fits the order value.
- At most one tote bag, and none on an order of ₹1,499 or less. A qualifying order
  may have none: the tote is subject to stock.

Medusa allows only one handler per hook, so the wallet check lives there too.
A repeat completion of a cart that is already an order (webhook retry, duplicate
event, verify and webhook racing) skips every check and returns the existing
order: refusing there would make Medusa refund a placed order.

### Prices at checkout (sales ending, price changes)

A cart line keeps the price it got when it was added, so checkout makes it current:

- `POST /store/carts/:id/payment-mode` (the storefront's checkout pricing) reprices
  any line whose price no longer matches today's price, then rechecks the tote.
- `POST /store/carts/:id/razorpay-session` (called by the storefront's
  create-order) reprices too, opens the Razorpay payment, and records a
  `payment_price_snapshot`: every line, the amount and the Razorpay order.
- At completion every line must be at today's price. The one exception is a
  Razorpay payment that matches its snapshot (same session, Razorpay order,
  lines and amount) and that Razorpay itself confirms was paid in full. That
  order is placed at the price paid, even if a sale ended during payment, and
  checkout pricing does not reprice a cart in that state.
- A failed, cancelled or short payment, a changed cart, Cash on Delivery and
  wallet-only orders get no exception: the customer sees "Prices in your cart
  have changed" and pays today's price on the next try.
- If Razorpay cannot be reached, completion answers 500 so verify or the
  webhook retries, and a cart that is already paid cannot open a second payment.

### Razorpay webhooks and crash recovery

Three paths can turn a paid cart into an order, and any mix of them is safe:
the browser's `/api/razorpay/verify`, the storefront webhook
`/api/razorpay/webhook`, and Medusa's own `/hooks/payment/razorpay_razorpay`.

- **Medusa's own webhook is guarded** (`src/api/hooks/middlewares.ts`). The
  plugin looks for the session in `payment.notes.session_id`, which checkout
  never sets; without the guard Medusa ran with no session and, in tests,
  captured another order's payment and completed an abandoned COD cart. The
  guard checks the signature, finds the session from `payment_price_snapshot`
  by Razorpay order id (it must still exist and match), writes it into the
  event and passes it on. No match: answered 200 and dropped (the storefront
  webhook still completes known carts). Bad signature: 400. Any other provider
  under `/hooks/payment/*`: 404.
- **Storefront webhook claims are temporary** (5 minutes) until the order is
  confirmed, then kept 30 days. A delivery that dies part-way no longer blocks
  Razorpay's redeliveries; one arriving while another is processing gets 409.
- **Razorpay ids and the confirmation email** are recorded through
  `POST /admin/razorpay-confirmations` (checks the Razorpay order is this cart's
  and Razorpay lists the payment as paid; merges into metadata; repeatable) and
  `POST /admin/orders/:id/confirmation-email` (one atomic claim, then sent or
  release). Both run from verify and the webhook, also for an already completed
  cart. A failed email is logged, not retried through the webhook: a webhook
  that keeps failing is switched off by Razorpay.
- **Never shipped without a checkout and a payment**: the dispatch claim checks
  the order is linked to its cart (or is a replacement its exchange names) and
  has a payment covering the amount due (wallet-only orders owe nothing). If
  not, it is held for 10 minutes, the reason shown in the Shipping panel, and
  checked again; "Ship now" does not override it. Orders made in Medusa admin
  without a cart are held too.
- **`reconcile-order-payments` job** (every 5 minutes, orders 5 minutes to 3
  days old): an order a crash left without a payment record gets it once
  proven (Razorpay confirms the session's order was paid in full, or it is COD),
  then `order.placed` is sent again so dispatch tracking and wallet redemption
  catch up (both ignore repeats). Unprovable ones and orders linked to no
  checkout are reported to the team (`order_payment_unconfirmed`,
  `order_orphaned`) and stay held. Nothing here refunds or cancels.
- **`recover-order-integrity` job** (every 10 minutes), four independent sweeps:
  - *Leftover orders.* Checkout writes the cart's own id into the cart's
    metadata (`eyra_checkout_cart_id`); Medusa copies it onto the order. An
    order that carries it, is linked to no cart, has no payment, no wallet
    deduction, no fulfilment, no shipment and is over 15 minutes old is voided:
    under the same lock Medusa's completion takes for that cart, its stock
    reservations are released, its dispatch record closed, and it is marked
    cancelled with the reason in its metadata. Medusa's `order.canceled` event
    is not sent, so no refund, wallet or credit-note handler runs. Orders made
    in Medusa admin never carry the marker and are never voided.
  - *Discount codes on leftovers.* Medusa counts a code's use in the step a
    crash can interrupt, so a leftover may have used up a once-per-customer
    code, and the customer's retry would then fail ("Promotion usage exceeds
    the budget limit") or Medusa would silently drop the code from the cart.
    When a leftover is voided, a use is given back only if Medusa's counter is
    higher than the uses of all real orders of that code (counter read first,
    so a concurrent checkout can only make it decline); otherwise nothing is
    given back, so no extra use is ever handed out. The given-back codes are
    recorded on the leftover (`orphan_codes_given_back`). Leftovers of a cart
    are cleared at once, without the 15 minute wait, before any change to that
    cart (`/store/carts/:id` and everything under it) and in the completion
    check itself, both under the cart's completion lock, so a retry right after
    the crash keeps its code.
  - *Stock reservations.* Checkout orders 5 minutes to 3 days old that are not
    cancelled, fulfilled or with the courier get any reservation they are
    missing: quantity times the inventory item's required quantity (a Pair
    anklet reserves two of the Single's stock), sales-channel locations first,
    never more than is free. What is missing and what is free are read again,
    and each reservation made, under the same per-inventory-item locks Medusa's
    own checkout reserves with, and the inventory module refuses an overdraw,
    so a repair and a live checkout (or two repairs) cannot both take the last
    unit. If no stock is free the team is told once (`stock_not_reserved`).
  - *Wallet deductions.* Checkout orders that used wallet credit with no
    `redeem:<order>` transaction (the `order.placed` event was lost) are
    redeemed. The redemption is locked per customer and the reference is
    unique, so it can never deduct twice; cancelled orders are skipped.
  - *Confirmation emails.* Paid checkout orders with no email after 10 minutes
    are retried through the storefront's `/api/orders/confirmation-email`
    (shared secret) after 10, 30, 60, 120 and 240 minutes, then the team is
    told (`confirmation_email_failed`). The email claim keeps every path to one
    send. Unpaid (held) orders are never emailed.
- **Redis outages fail fast.** Medusa's own Redis connections wait for Redis
  forever (BullMQ requires it), so a request would hang. The payment routes
  (`/hooks/payment/*`, cart complete, Razorpay session, payment mode, and the
  storefront's confirmation calls) ask Redis first on a separate connection
  with a 1 second timeout and answer 503 with `Retry-After: 30` while it is
  down. Razorpay and the storefront retry; the storefront's calls to Medusa time
  out after 25 seconds. The team is told after 30 seconds down and again on
  recovery (`redis_down`, `redis_recovered`).
- **Dispatch override for admin-made orders.** In the order's Shipping panel,
  "Allow dispatch" (staff sign-in only; API keys are refused; a reason of 10+
  characters is required) releases an order that is held only because no
  checkout is behind it. The payment must already be recorded (Medusa admin,
  mark as paid). Checkout leftovers and replacements cannot be released this
  way. Each grant and withdrawal is kept in `dispatch_override` (who, when,
  why) and the team is told (`dispatch_override`).
- **Alerts are only marked done when they went out.** `/api/ops/notify` now
  answers `sent: true` only when the alert email was sent, so the backend's
  "alerted" flags are set only then and a failed alert is tried again.

## Payment safety: production deployment

Do these in order.

1. **Backend (Railway).** Deploy, then in the shell run
   `npx medusa db:migrate` (adds `payment_price_snapshot` and
   `dispatch_override`).
2. **Redis.** Add a Railway Redis service and set `REDIS_URL` on the backend
   (`${{Redis.REDIS_URL}}`). One Redis per environment: staging and production
   must not share one, or their queues and locks mix. Redeploy. The log should
   show "Connection to Redis" for `event-bus-redis`, `workflow-engine-redis` and
   `locking-redis`, and the Shipping panel must no longer show the Redis
   warning. `projectConfig.redisUrl` alone does not move anything to Redis.
3. **Razorpay keys.** In production set `RAZORPAY_ID`, `RAZORPAY_SECRET`,
   `RAZORPAY_ACCOUNT` and `RAZORPAY_WEBHOOK_SECRET`, and do not define any
   `RAZORPAY_TEST_*` variable at all: the config prefers them with `??`, so even
   a blank one overrides the live value.
4. **Backend to storefront.** `STOREFRONT_REVALIDATE_URL` and
   `STOREFRONT_REVALIDATE_SECRET` must be set (alerts, email retries). Without
   them the recovery jobs still repair orders but tell nobody and retry no
   emails.
5. **Storefront (Vercel).** Deploy after the backend. Needs
   `MEDUSA_ADMIN_API_KEY` (Razorpay ids and email claim), the Upstash
   variables (webhook claims), `STOREFRONT_REVALIDATE_SECRET` (same value as the
   backend), `RESEND_API_KEY` with `EMAIL_MODE=live`, and a plan that allows
   `maxDuration = 60` on `/api/razorpay/webhook`.
6. **Razorpay webhooks.** Add `https://<backend>/hooks/payment/razorpay_razorpay`
   for `payment.captured` and `payment.authorized` with the backend's
   `RAZORPAY_WEBHOOK_SECRET`. Keep `https://<storefront>/api/razorpay/webhook`
   (`payment.captured`, `payment.failed`, `order.paid`).
7. **Check.** One small real payment: one order, one capture in Medusa, the
   Razorpay ids on the order, one confirmation email, and a dispatch record.
   One COD order and one wallet order the same way.

### Remaining limitations

- Medusa does not resume a cart completion that a crash stopped part-way, with
  or without Redis. The jobs and checks above repair the known leftovers
  (missing payment record, missing reservations, lost wallet deduction, unsent
  email, leftover order and its discount-code use); a link Medusa's parallel
  step did not make on an otherwise complete order (for example order to
  promotion) is not remade.
- Finding a cart's leftovers reads order metadata without an index, once per
  cart change. Fine at EYRA's order volume; add an expression index on
  `metadata->>'eyra_checkout_cart_id'` if orders grow into the hundreds of
  thousands.
- An order voided as a leftover is marked cancelled directly, without Medusa's
  cancel flow; it never had a payment, so there is nothing to refund.
- Emails are sent at least once: a crash between sending and marking it sent
  can send a second copy after the 10 minute claim expires.
- A request that passed the Redis check just before an outage can still hang
  until the storefront's 25 second timeout or Razorpay's own timeout; both
  retry, and every path is idempotent.
- Razorpay orders opened before this release have no snapshot: Medusa's own
  webhook ignores them and the storefront webhook completes them.
- Orders created in Medusa admin need "Allow dispatch" to ship, and their
  payment recorded first.

## Release steps

1. Merge the backend and storefront PRs. Deploy the backend first (the
   storefront calls its new routes).
2. Deploy the backend. In the Railway shell, first apply the database changes
   (the start command does not), then run the launch setup **once** per
   environment:
   ```bash
   npx medusa db:migrate
   npx medusa exec ./src/scripts/setup-launch-commerce.ts
   ```
   `db:migrate` also creates the `payment_price_snapshot` and
   `dispatch_override` tables. Deploy the backend before the storefront, and
   follow "Payment safety: production deployment" below for Redis, the Razorpay
   webhooks and the checks to run.

   It creates the two shipping options, the three codes, the tote bag product (a
   hidden product at ₹0 with no stock: set the real count in the admin under
   Inventory, or `TOTE_INITIAL_STOCK` the first time) and the GST rates in
   Medusa's tax module. It never deletes anything and is safe to run again. Add
   `DISABLE_OTHER_SHIPPING_OPTIONS=true` to also switch off the old "Standard
   Shipping" option (checkout ignores it either way).
3. Set the environment variables below on Railway and Vercel, then redeploy both.
4. Create the anklet and pendant products (next section).
5. In Medusa admin open any shipped order: the **Shipping** panel shows a
   warning list. It should be empty.

## Products: anklets and pendants

A product with several choices is just a Medusa product with an option and a
variant for each value. Medusa's variant price is the only price used.

**Anklet (single and pair)**
- Product type `anklet`. Create it with one variant at the single price `x` and
  stock it; nothing else is needed.
- The backend turns it into option `Pack` with `Single` (price `x`) and `Pair`
  (price `2x - 200`: ₹2,000 gives ₹3,800). The Pair has no stock of its own: it
  takes two of the Single's. Quantity counts the chosen option, so 3 Pairs are 6
  anklets at 3 × ₹3,800.
- Only edit the Single's price: the `sync-anklet-pair` subscriber and the
  `sync-anklet-pairs` job (every minute) set the Pair price, add a missing
  Pair, and move a Pair with its own stock onto the Single's.
- Sales: put the Single in a price list. The job gives the Pair a price in the
  same list at two sale singles less ₹200 (Single ₹1,200 on sale gives a ₹2,200
  Pair), so both start and end together. Price lists raise no event, so this
  happens within a minute of saving the sale.
  `npx medusa exec ./src/scripts/sync-anklet-pairs.ts` does it at once.
- Medusa checks stock one cart line at a time, so the cart hooks in
  `src/workflows/hooks/cart-shared-stock.ts` (and the order check) add up a
  Single line and a Pair line that share stock.
- The parcel weight counts a pair twice (variant title containing "Pair").

**Pendant (optional silver chain)**
- Option `Chain` with values `Pendant only` and `With silver chain`.
- `Pendant only`: the pendant price. `With silver chain`: that price + ₹1,000.
- **Stock is separate for each variant (confirmed).** Each variant has its own
  inventory, so "With silver chain" stock is the number of pendants you have set
  aside with a chain, and "Pendant only" is the number you hold alone. Selling
  one never takes from the other, and neither takes from the separate chain
  products. Top up each variant's stock on its own. This is tested: see
  `integration-tests/http/variant-stock.spec.ts`.

The storefront's product page shows every non-size option as a choice with its
own price, adds exactly the chosen variant, and keeps lines for different
variants apart. Nothing in the browser can change a price: the cart sends only a
variant id, and the cart is re-read from Medusa after every change.

To try it locally with sample products (not for production):
`npx medusa exec ./src/scripts/seed-variant-demo.ts`

## The complimentary tote bag

Orders with items worth strictly more than ₹1,499 get a complimentary tote bag
while stock lasts, one per order. ₹1,499 does not qualify and ₹1,500 does. The
basis is the price of the items before any discount and without shipping, and the
tote itself never counts towards it.

- It is a real Medusa product (`eyra-complimentary-tote`, SKU `EYRA-TOTE`) at a
  price of ₹0, with its own stock, flagged `hidden_from_shop` so the shop never
  lists or opens it.
- The storefront calls `POST /store/carts/:id/reconcile` after every cart change.
  It adds the tote when the items qualify and it is in stock, takes it off when
  they stop qualifying, and keeps it to one. If it is out of stock the order simply
  has none ("subject to stock availability"); that is never an error.
- It is a line on the cart, the order, the invoice (as a ₹0 line, no tax) and the
  Shiprocket packing list, so the packing list stays automatic. Its stock goes down
  when the order is placed, like any product.
- The completion check refuses a tote on an order that does not qualify, and two.
- Shiprocket gets it at a price of ₹0. If Shiprocket ever rejects that, set
  `SHIPROCKET_FREE_GIFT_PRICE=one_rupee` on the storefront: it is then sent at ₹1
  with a ₹1 discount, which nets to zero.

## Invoices: how the numbers are worked out

- **Prices include 3% GST.** The discount is taken off the inclusive price
  first, then the GST is taken out of what is left:

  ```
  GST   = amount × 3 / 103        (rounded to the paisa)
  base  = amount − GST
  ```

  so base plus GST is exactly the product amount, always. Worked on whole paise.
  Example: ₹3,800 with EYRA350 is ₹3,450; GST ₹100.49; taxable value ₹3,349.51.
- **The discount is spread over the product lines in proportion to their price
  before tax is worked out**, in whole paise (the odd paisa goes to the largest
  remainder). Each line's GST is then taken out of its own net value, so a line's tax
  mirrors its share of the net invoice, and a credit note for part of an order
  reverses exactly what the invoice shows. Example: ₹2,000 and ₹1,000 with ₹350 off
  take ₹233.33 and ₹116.67 off; the lines are ₹1,766.67 and ₹883.33.
- Inside the seller's state the GST is shown half CGST, half SGST (an odd paisa
  goes to CGST); to any other state it is all IGST.
- **The Cash on Delivery charge is its own invoice line**, ₹99, never mixed into
  the product amount or the product GST. It includes **18% GST under SAC 9997**:
  taxable value ₹83.90 plus GST ₹15.10 (CGST 9% and SGST 9%, or IGST 18%). The
  invoice total is the product amount plus that charge. The tax summary lists one
  group per rate.
- **The tote** is a ₹0 line, no HSN, no discount, no tax.
- The rates are `JEWELRY_GST_RATE` (3), `JEWELRY_HSN_CODE` (7113), `COD_GST_RATE`
  (18) and `SERVICE_SAC_CODE` (9997), the same on the backend and the storefront.
  `apps/backend/src/utils/gst-math.ts` and the storefront's `lib/gst.ts` do the same
  sums and are tested on the same examples.

## S3 file storage

Without this, product images uploaded in the admin vanish on every Railway
deploy, and invoice PDFs would too.

### Bucket

1. Create a bucket in your region (for example `eyra-media`, `ap-south-1`).
2. **Object Ownership**: choose *Bucket owner preferred* (ACLs enabled). Medusa
   marks images `public-read` and invoices `private` object by object, which
   needs ACLs.
3. **Block Public Access**: turn off only *"Block public access to buckets and
   objects granted through new access control lists (ACLs)"* and *"...through any
   access control lists (ACLs)"*. Leave the two *public bucket policy* blocks on.
   Do not add a bucket policy that makes everything public: invoices stay private
   because their objects are private.
4. Optional: put CloudFront in front and use its domain as `S3_FILE_URL`.

### IAM user (backend only)

An IAM user with access keys, limited to this bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::eyra-media/*"
    }
  ]
}
```

On Railway, set `S3_BUCKET`, `S3_REGION`, `S3_FILE_URL`
(`https://eyra-media.s3.ap-south-1.amazonaws.com`), `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, and optionally `S3_PREFIX`. **Keep the keys on the
backend only.** The storefront never needs AWS credentials.

### Storefront

Set `MEDUSA_IMAGE_HOSTS` on Vercel to the bucket's hostname
(`eyra-media.s3.ap-south-1.amazonaws.com`) **at build time** and redeploy. Only
hostnames listed there (plus eyra.org.in) can be optimised; wildcard hosts are
refused, and the old allowances for every S3 bucket, Cloudinary, Supabase and
the like are gone. If your catalogue images live on one of those, list the
exact host.

### Existing images

Images already uploaded to Railway's disk are gone or will be. List what needs
re-uploading (read-only):

```bash
npx medusa exec ./src/scripts/audit-product-images.ts
```

Then re-upload each in Admin, Products, the product, Media. Images served from
`www.eyra.org.in/images/...` (the seeded catalogue) are fine as they are.

### What was and was not tested

Tested here: the S3 settings, and Medusa's real S3 provider (upload, private and
public ACLs, signed link, delete) against an in-process stand-in server. **Not
tested: a real AWS bucket**, so confirm after setup by uploading one image and
refreshing a product page, then opening one invoice.

## Invoice PDFs

- The tax invoice **number** is issued when the order ships (unchanged). The PDF
  is made afterwards by a job (`generate-invoice-pdfs`, every 5 minutes) and
  also on first request. It never blocks or holds up shipping, and it never
  issues a number: it reads the one on the order.
- The storefront draws the PDF (`/api/invoices/render`) from the same data as the
  invoice page, so the two always agree. The backend saves it once as a
  **private** S3 object and records the key on the order's metadata
  (`invoice_pdf`). A stored PDF is never replaced.
- Asking again, or two people asking at once, draws one PDF. If anything fails
  the job retries with a growing delay (5 minutes up to about 3 hours) and emails
  the team once after six failures.
- **Staff**: Medusa admin, order page, Shipping panel, *Tax invoice*: **View PDF**
  or **Download**. It uses the normal admin sign-in. `?draft=1` shows an invoice
  that is not valid yet, marked as such, and never stores it.
- **Customers**: the invoice page has **Download PDF**. The storefront checks the
  signed-in customer owns the order and then streams the file. There is no public
  or guessable address; S3 objects are private.
- **Seller GSTIN**: set `SELLER_GSTIN` (and the other `SELLER_*` values) on the
  storefront. Without a valid 15-character GSTIN the invoice page and PDF say
  "not a valid tax invoice", the PDF is not stored, and the team is alerted if
  an order keeps failing. Once it is set the job stores the missing PDFs by
  itself. A GSTIN is never invented.

### Confirmed: WELCOME200 stays used after a cancellation

Medusa records a code's use when the order is placed and does not give it back
when the order is cancelled. That is the wanted behaviour: a customer who
cancels cannot use WELCOME200 again. It holds for a cancellation by the customer
and one by staff in the admin, and it is tested
(`integration-tests/http/cancellation-restrictions.spec.ts`). EYRA350 and EYRA650
are unaffected. If Medusa ever starts returning the use, that test fails.

### Credit notes

Built: see `docs/returns-credit-notes-cancellations.md`. A credit note is issued
for a return, an exchange, a cancellation by staff after the order shipped, and a
parcel refused and sent back. It has its own gap-free series (`CN/26-27/0001`),
names the invoice it reverses, reverses the 3% GST on the returned lines (and the
18% on the COD charge when that is owed back), is kept as a private PDF in
`credit-notes/FY26-27/`, and feeds a monthly GSTR-1 CSV.

### Questions for the accountant or owner

- The ₹99 reverse logistics fee carries 18% GST, shown on the credit note and in
  the GSTR-1 CSV, with no separate invoice. Tell us if the accountant wants one.
  Exchanges have no fee.
- Whether a customer with a GSTIN needs their GSTIN captured at checkout (credit
  notes carry it when there is one; checkout does not ask today).

## Shiprocket: what you must do in production

Built and tested: the shipment now sends the discount, the Cash on Delivery
charge and a packing note, counts a pair of anklets twice for weight, and the
admin Shipping panel warns about a missing or expiring token, missing webhook
secret or pickup location. **Not tested live**: creating a real courier shipment
(needs a funded Shiprocket wallet and access), and live rates.

1. Create a Shiprocket **API user** and set `SHIPROCKET_EMAIL` and
   `SHIPROCKET_PASSWORD` on the **storefront**. The token then renews itself.
   Without them a pasted token stops working after about ten days.
2. Set `SHIPROCKET_PICKUP_LOCATION` to the exact name in the Shiprocket dashboard.
3. Set `SHIPROCKET_WEBHOOK_SECRET` (on the storefront **and** the backend) and
   enter the same value in Shiprocket's webhook settings (header `x-api-key`),
   pointing at `https://<storefront>/api/tracking/webhook`. The storefront passes
   every update on to the backend, which tracks delivery (the 7-day return window),
   refused parcels and reverse pickups. Shiprocket can also be pointed straight at
   `https://<backend>/webhooks/shiprocket/order-update`.
3a. For return pickups set `SHIPROCKET_RETURN_PHONE` (and optionally the
   `SHIPROCKET_RETURN_*` address) on the storefront: Shiprocket needs a phone for
   the warehouse the item is delivered to.
4. Keep ₹100 or more in the Shiprocket wallet, or assigning a courier fails.
5. The old flat ₹79 shipping fallback no longer affects customers: the charge is
   now free (prepaid) or ₹99 (COD). The backend token (`SHIPROCKET_API_TOKEN`)
   only feeds an internal rate estimate and is optional. If it is missing or
   rejected, the backend now says why in its log instead of failing silently.

## Environment variables

Backend (Railway): see `apps/backend/.env.template`. New: `S3_*` and
`STOREFRONT_SHIPMENT_SECRET` (earlier), and for this work `SELLER_*`,
`SHIPROCKET_WEBHOOK_SECRET`, `JEWELRY_GST_RATE`, `JEWELRY_HSN_CODE`,
`COD_GST_RATE`, `SERVICE_SAC_CODE`, `CREDIT_NOTE_PREFIX`, `CREDIT_NOTE_S3_PREFIX`,
`CREDIT_NOTE_S3_BUCKET`, `RTO_AUTO_REFUND`, `TOTE_INITIAL_STOCK`,
`WALLET_CREDIT_VALIDITY_MONTHS` (12), and optional `DISABLE_OTHER_SHIPPING_OPTIONS`.
`ORDER_CANCEL_FEE` is no longer used.

Storefront (Vercel): see `.env.example` there. New: `MEDUSA_IMAGE_HOSTS`,
`SELLER_*`, `SHIP_WEIGHT_PENDANT_G`, and for this work `COD_GST_RATE`,
`SERVICE_SAC_CODE`, `SHIPROCKET_FREE_GIFT_PRICE`, `SHIPROCKET_RETURN_*`,
`WHATSAPP_PROVIDER`, `WATI_*`, `AISENSY_API_KEY`, `WHATSAPP_TEMPLATE_*`.

Packages added: `pdfmake` (both repos), and in the storefront `@types/pdfmake`
and `pdf-parse` (tests). Database migrations: the credit note module (new),
the return request fields, and the dispatch delivery tracking fields.
