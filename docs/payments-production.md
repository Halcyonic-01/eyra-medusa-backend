# Payments: production readiness runbook

Razorpay and PayU (hosted checkout) as built in phases 1 to 7. This covers what
to configure, in which order to deploy, how to roll back, and what to watch.
The storefront has its own short companion in the EYRA repo
(`docs/payments-production.md`).

## 1. What runs where

| Piece | Where | Purpose |
|---|---|---|
| Razorpay plugin `pp_razorpay_razorpay` (through `src/modules/razorpay-payment`, which fixes its refunds) | backend | Razorpay sessions, authorize, capture, refunds |
| PayU provider `pp_payu_payu` | backend (`src/modules/payu-payment`) | PayU sessions, verify_payment, refunds |
| Webhook guard | backend `/hooks/payment/:provider` | Signature or hash check, attaches the backend's own session, duplicate protection (`payment_webhook_event`) |
| Attempt ledger | backend `payment_price_snapshot`, `late_razorpay_payment` | Every payment attempt and every late, recovered or refunded payment |
| `reconcile-current-attempts` job, every 5 min | backend | Paid but unconfirmed attempts (missed webhooks, closed browser) are completed, or refunded if the cart refuses them |
| `reconcile-late-payments` job, every 5 min | backend | Payments on replaced attempts are recovered or refunded; refunds owed are retried |
| `verify-payment-refunds` job, every 30 min | backend | Follows accepted refunds until the provider pays them out; failed ones are sent again (late payments) or flagged (cancellations) |
| `reconcile-order-payments` job, every 5 min | backend | Orders an interrupted checkout left without a payment record |
| `/store/carts/:id/payment-status` | backend | What the storefront tells the customer; whether paying is allowed |
| Checkout, `/api/razorpay/*`, `/api/payu/*`, `/api/checkout/payment-status`, `/payment-status` | storefront | Customer flows; the storefront never decides a payment succeeded |

## 2. Environment variables

Never put live credentials in a test environment, or test credentials in
production. The admin's dispatch panel and the `dispatch-held-orders` job log
list configuration problems (`paymentConfigProblems`); check them after every
deploy.

### Backend (Railway)

| Variable | Required | Notes |
|---|---|---|
| `REDIS_URL` | yes | Locks, events and the workflow engine. Without it locks are per instance and the duplicate and race protections do not hold across instances. |
| `RAZORPAY_ID`, `RAZORPAY_SECRET`, `RAZORPAY_ACCOUNT` | yes | Live key (`rzp_live_…`). A `rzp_test_` key in production is flagged. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret of the webhook pointing at the backend (section 4). Missing: Razorpay webhooks are refused (503) and only the sweeps confirm payments. |
| `RAZORPAY_TEST_*` | **must be unset** | They take precedence over the live values; flagged in production. |
| `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT` | for PayU | From the PayU dashboard. The salt never leaves the backend. |
| `PAYU_MODE` | for PayU | `live` in production. In live mode PayU switches itself off (never half-on) if `PAYU_CHECKOUT_URL` or `PAYU_API_URL` point outside PayU, or the return URLs are not https. |
| `PAYU_SUCCESS_URL`, `PAYU_FAILURE_URL` | for PayU | Both `https://www.eyra.org.in/api/payu/return` (PayU allows 50 characters). |
| `PAYU_CHECKOUT_URL`, `PAYU_API_URL` | **leave unset** | Local fakes only. |
| `REFUND_GATEWAY` | **leave unset** | `fake*` values are test stand-ins; ignored in production since phase 7, and flagged. |
| `PAYMENT_STATUS_CACHE_MS` | no | Reuse of `/payment-status` answers per cart, default 5000. Keeps public callers from using up provider API limits. |
| `STOREFRONT_REVALIDATE_URL`, `STOREFRONT_REVALIDATE_SECRET` | yes | Ops alerts (late payments, refund failures) reach the team through the storefront. |

### Storefront (Vercel)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_MEDUSA_BACKEND_URL`, `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` | yes | Build time: a change needs a redeploy. |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | Same live key as the backend. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret of the webhook pointing at the storefront (section 4). |
| `NEXT_PUBLIC_PAYU_ENABLED` | for PayU | `true` shows "Prepaid via PayU". Build time. Turn on last (section 5). |
| `PAYU_CHECKOUT_ORIGIN` | **leave unset** | Local fake only; ignored for anything but localhost since phase 7. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | yes | Production's own Upstash database, never shared with development or tests. |
| `EMAIL_MODE`, `RESEND_API_KEY` | yes | Order confirmation emails. |

## 3. Migrations

All additive (new tables or nullable columns), safe to run before the new code
is live, and safe while the previous release is still serving. Run
`npx medusa db:migrate` on deploy; it skips what is already applied.

| Module | Migration | Phase | Adds |
|---|---|---|---|
| paymentSnapshot | `Migration20261123130347` | 1 | `superseded_at`, `late_checked_at`, table `late_razorpay_payment` |
| paymentSnapshot | `Migration20261123145803` | 2 | provider-neutral columns and backfill |
| orderDispatch | `Migration20261125143447` | 5 | `order_cancellation.refund_verified_at`, `refund_checked_at` |
| paymentSnapshot | `Migration20261125143510` | 5 | table `payment_webhook_event`, `late_razorpay_payment.refund_*_at`, `payment_price_snapshot.reconciled_at` |

Phases 6 and 7 add no migrations. Do not run `down`: phase 2's `down` fails
once PayU rows exist, and nothing needs it (section 6).

## 4. Provider dashboards

**Razorpay** (Settings, Webhooks), two webhooks, each with its own secret:

1. `https://<backend>/hooks/payment/razorpay_razorpay`, events `payment.authorized`,
   `payment.captured`, `refund.processed`, `refund.failed`; secret = backend `RAZORPAY_WEBHOOK_SECRET`.
   This is the one that records captures in Medusa.
2. `https://www.eyra.org.in/api/razorpay/webhook`, events `payment.captured`,
   `order.paid`, `payment.failed`; secret = storefront `RAZORPAY_WEBHOOK_SECRET`.
   It completes carts and sends the confirmation email.

**PayU**: webhook (payment success and failure) to `https://<backend>/hooks/payment/payu_payu`.
The webhook is only a trigger: the backend checks the hash and then asks PayU (verify_payment).

## 5. Deployment order

Backend first; the storefront calls backend routes that must exist.

1. Merge the backend PRs in order: phase 5 (`feat/payment-reconciliation`), phase 6
   (`feat/payment-fallback-ux`), phase 7 (`feat/payment-production-readiness`).
2. Backend: set the variables (section 2), deploy, run `npx medusa db:migrate`.
3. Check the admin's configuration problems are empty for payments, and that the
   jobs run (`reconcile-current-attempts`, `verify-payment-refunds` in the logs).
4. Configure the provider webhooks (section 4).
5. Storefront: merge the phase 6 and phase 7 PRs, deploy with `NEXT_PUBLIC_PAYU_ENABLED=false`.
6. Smoke test with Razorpay (one small real payment, then refund it from the admin).
7. PayU: add `pp_payu_payu` to the India region's payment providers (admin, Settings,
   Regions), then set `NEXT_PUBLIC_PAYU_ENABLED=true` and redeploy the storefront.
   Smoke test one PayU payment and refund.

Rolling deploys are safe: the checkout lock key (`razorpay-checkout:{cart}`) is
shared by every release since phase 1.

## 6. Rollback

- **Storefront**: Vercel instant rollback to the previous deployment. Payments in
  flight are still confirmed by the backend's webhooks and sweeps.
- **PayU only**: set `NEXT_PUBLIC_PAYU_ENABLED=false` and redeploy the storefront, and
  remove `pp_payu_payu` from the region, so no new PayU payment opens. **Keep the PayU
  keys on the backend for at least 72 hours**: without them the sweeps cannot ask PayU
  about payments already made, and nothing is decided for those (they are not lost, but
  wait).
- **Backend**: redeploy the previous release. Leave the migrations in place: the
  added tables and columns are ignored by older code. Duplicate protection
  (`payment_webhook_event`) only exists from phase 5; an older release handles
  duplicates as before (idempotent, noisier).
- **Never** delete rows from `late_razorpay_payment` or `payment_price_snapshot`: they
  are what prevents a payment being refunded or ordered twice.

## 7. Monitoring

**Alerts the team already gets** (through the storefront's `/api/ops/notify`):
`late_payment` (refunded, or needs a person), `refund_missing_after_cancel` (also sent
when a provider fails a cancellation refund), `order_payment_unconfirmed`, `order_orphaned`.

**Log lines to alert on**:

| Pattern | Meaning | Action |
|---|---|---|
| `[razorpay-hook] rejected a webhook with a bad or missing signature` | wrong secret, or forged calls | check the dashboard secret; repeated from one IP: forged |
| `[payu-hook] rejected a webhook with a bad or missing hash` | same, PayU | same |
| `could not record payment.` / `could not record success:` | webhook ledger unavailable (answered 503) | database or Redis trouble; the provider retries |
| `[reconcile] … could not be asked … will retry` | provider API unreachable | many in a row: provider outage, payments wait |
| `[missed-payment] … paid … expected` | amount mismatch, a person must look | refund or place the order by hand |
| `[refund-verify] … failed refund` | provider failed a refund | late payments: sent again automatically; cancellations: retry from the admin |
| `[late-payment] … needs_review` / ops alert "needs a person" | automatic handling gave up | check the payment in the provider dashboard |

**Health queries** (read-only, against the production database):

```sql
-- Owed or stuck refunds, and payments waiting for a person
SELECT status, count(*) FROM late_razorpay_payment WHERE deleted_at IS NULL GROUP BY status;
-- Cancellation refunds not confirmed paid out
SELECT refund_status, count(*) FROM order_cancellation WHERE refund_method = 'original' AND refund_verified_at IS NULL GROUP BY refund_status;
-- Duplicate webhook deliveries (high numbers: a provider retrying something we answer badly)
SELECT provider_id, sum(deliveries), sum(duplicates) FROM payment_webhook_event WHERE created_at > now() - interval '1 day' GROUP BY provider_id;
```

Also watch the provider dashboards for webhook failure rates (Razorpay disables a
webhook that keeps failing), and the storefront for 429s on `/api/payu/*` and
`/api/checkout/payment-status`.

## 8. Test coverage and sandbox status

| Scenario | Razorpay | PayU |
|---|---|---|
| Success, browser return | `razorpay-webhook-recovery`, storefront | `payu.spec`, storefront `payu-checkout` |
| Failure, cancel | storefront logic, `payment-standing` | `payu.spec`, storefront `payu-checkout` |
| Pending UPI, then paid; hold against paying twice | `payment-standing` | `payment-standing`, `payment-reconciliation`, storefront |
| Duplicate payments (second attempt, other gateway, COD) | `payment-foundation`, `payment-standing` | `payu.spec`, `payment-standing` |
| Refunds, refund later failed, token reuse | `payment-reconciliation`, `razorpay-late-payment`, `cancellation-refund` | `payment-reconciliation`, `payu.spec` |
| Webhook duplicates, retries, ledger down, signature | `payment-reconciliation`, `razorpay-webhook-recovery` | `payment-reconciliation` |
| Missed webhooks, gateway down, reconciliation | `payment-reconciliation` | `payment-reconciliation`, `payu.spec` |

These run against protocol-accurate fakes of the providers' APIs (hashes and
signatures checked the documented way), and Razorpay was also run end to end
against the real **Razorpay test environment** (test keys only, 2026-11-26):

| Sandbox flow | Result |
|---|---|
| Backend opens a real test order at the cart's amount | ✅ |
| Failed tries (simulated bank outage, cancelled wallet, international card, bank "Failure") | ✅ `payment.failed` with Razorpay's reason; nothing taken; status `none`, any method allowed |
| A try left `created` by Razorpay after a failure | ✅ after the fix below: status `pending` + `resume`, same Razorpay order reused, no second order |
| Successful payment (netbanking, mock bank "Success") | ✅ order `paid`, one captured payment |
| Paying again by Razorpay or PayU once paid | ✅ refused ("already been paid") |
| Missed webhook (none can reach a laptop) | ✅ the sweep placed the order on its next run; one Medusa payment, one capture |
| The same `payment.captured` delivered late, retried, and forged | ✅ late and retry answered as already recorded, forged refused (400) |
| Staff Cancel in Medusa admin refunds Razorpay | ✅ after the fix below (`rfnd_…` processed, ₹4,999) |
| EYRA's own refund path (customer cancel, late payments): idempotent, status followed | ✅ two calls, one refund; status `pending` then followed |

Still to do by hand: a Razorpay test webhook to a reachable backend (a staging
deploy), and every PayU flow on `test.payu.in` with a PayU test merchant key
(none were available), before enabling PayU.

### Found in the sandbox and fixed

- **Medusa refunds of Razorpay payments never reached Razorpay.** Medusa passes the
  refund amount in its raw form; the Razorpay plugin read it as `NaN`, matched no
  payment and returned as if refunded, so Medusa recorded refunds that never
  happened (admin Cancel, admin Refund). `src/modules/razorpay-payment` wraps the
  plugin's provider: the amount is converted, and a refund the plugin still does not
  make fails instead of being recorded. Customer cancellations were not affected
  (they refund through EYRA's own path). **Check production for orders cancelled from
  the admin since launch: their refunds may never have been sent** (Razorpay
  dashboard, refunds on the payment; or the `refund_missing_after_cancel` alerts).
- **A failed Razorpay try blocked paying for 30 minutes.** Razorpay keeps a failed or
  abandoned try as `created` (it may still authorize late), which the phase 6 hold read
  as pending. When that try is on the cart's current Razorpay order and the cart is
  unchanged, paying again now continues the same order (`resume`), which Razorpay lets
  be paid once only; switching gateway still waits.
- **The missed-payment sweep could be starved** by a backlog of abandoned checkouts (and
  by an unreachable gateway), delaying a real missed payment by hours. It now asks the
  newest attempts first, backs off on old ones (5 min under an hour, 30 min under six
  hours, then 3 hours), and stops asking a gateway for the rest of a run once it is
  unreachable.

### Razorpay account settings to check before launch

- **Balance for refunds.** Refunds are paid from the Razorpay balance; a refund larger
  than the balance is rejected with a generic `invalid request sent` (seen in the
  sandbox). EYRA retries and then hands it to a person, but keep a buffer, or enable
  refunds from a reserve, especially right after a settlement.
- **Late authorizations.** Razorpay can authorize a stuck `created` try after the order
  was paid another way; set it to refund late authorizations automatically (Settings,
  Payment capture).

## 9. Security review (phase 7)

Fixed:

- `REFUND_GATEWAY=fake*` would have made every refund report success without moving
  money if set in production. Now ignored in production and flagged.
- PayU live mode accepted `PAYU_CHECKOUT_URL` / `PAYU_API_URL` overrides to any host and
  plain-http return URLs. Now PayU switches off instead.
- The storefront's `PAYU_CHECKOUT_ORIGIN` (local fakes) was honoured for any origin. Now
  only for localhost.
- PayU webhook duplicate keys used `mihpayid`, which PayU's hash does not cover; a replay
  with it edited counted as new. Now keyed on hash-covered fields (status, txnid).
- Cash on Delivery could be completed through Medusa's public complete route while an
  online payment was still pending. The backend now refuses it until the payment settles
  (or fails), failing closed if the provider cannot be asked.
- The public payment-status route asked the providers on every call; answers are now
  reused per cart for a few seconds.
- Payment configuration problems (test keys or test overrides in production, missing
  webhook secret, unsafe PayU settings, PayU URLs too long) are now reported.

Checked and sound: Razorpay HMAC on raw bytes with constant-time compare (backend and
storefront); PayU reverse hash with constant-time compare and merchant-key check; the
session to act on always comes from the backend's own records, never the request;
amounts and attempts from the backend only; refunds idempotent per refund id (Razorpay
receipt and notes; PayU tokens, a new one only after a confirmed failure); every
decision under the checkout and cart locks; uncertain provider answers never treated
as paid or unpaid; no secrets in the repositories or their history.

Accepted risks:

- The cart id is the only credential for `/store/carts/:id/payment-status` and the
  storefront's `/api/checkout/payment-status` (as for every Medusa store cart route).
  It reveals payment state and the order id for that cart only.
- The PayU return cookie (24 hours, httpOnly, `/api/payu` only) holds the customer's
  name and email as PayU posted them.
- A Razorpay refund re-sent after Razorpay failed the first carries the same receipt;
  should Razorpay refuse a repeated receipt, the refund goes to a person after five tries.
