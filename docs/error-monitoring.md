# Error monitoring (Sentry): backend

The storefront's side, the privacy rules they share, and the Sentry dashboard
checks are in `EYRA/docs/error-monitoring.md`. This page covers the backend.

## How errors reach Sentry

Every failure worth knowing about already reaches Medusa's logger, so Sentry is
wired in there, once (`src/utils/sentry.ts`, `reportingLogger`, set as `logger` in
`medusa-config.ts`):

| Failure | Medusa logs it as | Reported |
|---|---|---|
| An API route answers 500 (any thrown error that isn't a client mistake) | `logger.error(err)` by Medusa's error handler | yes, with the request |
| An API route answers 4xx (not found, invalid data, not allowed) | not logged | no: the customer's mistake, not a bug |
| A scheduled job throws | `logger.error("Scheduled job … failed …")` | yes |
| A subscriber throws | two warnings: the event, then the error | yes, as "subscriber of `<event>` failed" |
| EYRA's own failures, such as `[payment-reconcile] … not repaired` | `logger.error(...)` | yes, grouped by message |

- **Grouping.** Messages that differ only in ids or numbers ("order order_01…
  not repaired") are one Sentry issue, not one per order.
- **Warnings aren't reported,** other than a crashed subscriber.
- **Unhandled rejections and crashes** of the process are reported by Sentry's
  Node handlers.
- **Started by** `instrumentation.ts`, which Medusa runs at start-up, after loading
  the config and `.env`.

## Privacy

Sentry 11 collects cookies, request bodies, query values, local variables and user
details by default. All are off (`DATA_COLLECTION`). Request bodies hold
addresses and phone numbers, and headers hold the admin session and API keys.

`scrubEvent` doesn't rely on that, and fails closed. It's the same filter as the
storefront's (see `EYRA/docs/error-monitoring.md`, Privacy):

- the request is rebuilt from an allowlist (method, URL without query values, a
  few headers)
- the user is removed
- exceptions, breadcrumbs, `extra`, tags and any unknown field are scrubbed in
  depth, and personal keys are matched in any casing
- unknown contexts are dropped, and anything too deep or circular becomes
  `[filtered]`
- emails, phone numbers, card numbers, tokens, API keys and quoted SQL values are
  replaced in all text

Tested with one event carrying personal data in every field:
`src/utils/__tests__/sentry.unit.spec.ts`.

## Checked against the whole test suite

The integration suite was run with Sentry pointed at a fake server, and every
event was listed against the test that caused it.

- **Customer mistakes:** none produced an event. That covers declined and
  refused payments, invalid codes, out of stock, refused returns and not
  allowed, all of which answer 4xx and aren't logged as errors.
- **Every event was a real problem the test simulates on purpose:**
  - a refund the provider refused or failed
  - a recovered payment for a cart that can no longer be completed
  - a missing credit-note GSTIN
  - a courier booking refused
  - an email or WhatsApp that could not be sent
  - a payment that is owed or unconfirmed
- **No duplicates:** no failure was reported twice by the same path. Where two
  events share a trace, they are two facts (a refund failed, then a cancellation
  stays unrefunded), or two independent attempts that both failed (the
  late-payment subscriber and the checkout guard, while Razorpay was down).
- **Found on the way:** the dispatch of an exchange's replacement order failed in
  7 tests with `duplicate key … IDX_order_dispatch_invoice_number_unique`. That
  has to be looked into on its own; Sentry will report it if it happens in
  production.

## Environments and releases

- **Environment:** `SENTRY_ENVIRONMENT`, else Railway's environment name
  (`RAILWAY_ENVIRONMENT_NAME`), else `production` or `development` from `NODE_ENV`.
- **Release:** `SENTRY_RELEASE`, else Railway's Git commit
  (`RAILWAY_GIT_COMMIT_SHA`).
- **Stack traces:** they point at the built JavaScript in `.medusa/server`. That
  code is compiled, not minified, so it stays readable.

## Performance

- **Errors only, no tracing.** That keeps the overhead low.
- **Linked traces:** the storefront sends its trace id to the backend, so a
  backend error appears on the trace of the storefront request that caused it.
- **Deeper tracing:** follow Medusa's Sentry guide (`registerOtel` with Sentry's
  OTLP endpoint) if per-workflow timing is wanted later.

## Configuration

`SENTRY_DSN` only (Railway). Use the backend's own Sentry project, not the
storefront's.
