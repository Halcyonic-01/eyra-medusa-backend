# Product analytics (PostHog): backend

The full description (architecture, every event, identity, privacy, configuration,
PostHog dashboards) is in the storefront repo: `EYRA/docs/analytics.md`. This page
covers the backend's part.

## What the backend sends

| Event | Medusa event | Properties |
|---|---|---|
| `order_placed` | `order.placed` | `order_id`, `value` (rupees), `currency`, `item_count`, `payment_method` (`razorpay`, `payu`, `cod`, `wallet`), `has_discount`, `wallet_credit_used` |
| `order_cancelled` | `order.canceled` | the same |

These come from the backend because only it sees every order exactly once, however
it was placed: the customer's browser, a payment webhook, or the missed-payment sweep.

## How

- `src/subscribers/analytics-order-events.ts` hears Medusa's `order.placed` and
  `order.canceled` and calls `sendOrderEvent` (`src/utils/analytics-orders.ts`).
- `sendOrderEvent` reads the order (ids, amounts and categories only) and sends one
  `POST {host}/i/v0/e/` through `src/utils/posthog.ts` (no SDK, a 5-second timeout).
  - **It never throws.** A failure is logged as `[analytics] … not sent` and the
    order is untouched.
- **The person** is the order's `customer_id` (`cus_…`), the same id the storefront
  identifies the customer with. Server events therefore join the customer's browser
  journey.
  - With no customer, the event is still counted, without creating a person.

## Consent

Order events are sent only for a customer who accepted analytics. The storefront
records the choice on the Medusa profile when it's made, or at sign-in
(`metadata.analytics_consent`: `{ status, at, version }`).

- `src/utils/analytics-consent.ts` decides. An event is sent only if the current
  status is `granted` and `at` is at or before the event's time.
  - No choice, `denied`, or a different version: not sent.
  - Withdrawn: nothing more is sent, including events waiting in the backlog.
  - Given after the order: not sent, because consent isn't retroactive.
- It's checked inside `sendOrderEvent`, which the subscriber and the backlog job
  both use, and read fresh on every attempt.
- An order with no customer is never sent.
- An order without consent gets no marker. The backlog checks it again on each
  run within its 3-day window and still doesn't send it. That costs one small
  query per order.

Tests: `src/utils/__tests__/analytics-consent.unit.spec.ts`, and
`integration-tests/http/analytics.spec.ts` (granted, missing, declined, withdrawn
after the order, given after the order, withdrawn before a cancellation).

## Exactly once

Medusa can announce one order more than once: the payment repair job
(`reconcile-order-payments`) emits `order.placed` again for an order it repairs.
PostHog only drops a repeated `uuid` inside one request, not across requests, so
the backend makes sure itself:

- **A send is recorded on the order.** After PostHog accepts it, the order's
  metadata gets `analytics_placed_sent_at` (or `analytics_cancelled_sent_at`). A
  repeat finds the marker and sends nothing.
- **One sender at a time.** The check and the send run under a per-order lock
  (`analytics:<event>:<order id>`), so the subscriber and the backlog job never send
  the same order together.
- **Nothing is lost for long.** `src/jobs/send-analytics-backlog.ts` runs every 15
  minutes. It sends any order from the last 3 days that has no marker and is more
  than 10 minutes old: PostHog was down, or Medusa's own event was lost. The orders
  table is the outbox; no new table is needed.
- **The one gap left.** If the server dies after PostHog accepted an event but
  before the marker is written, the backlog sends it again. The event keeps its
  stable `uuid` and timestamp, so PostHog shows it as a duplicate warning. That
  takes a crash in a window of milliseconds.
- **The payment method is as of the first send.** An order sent before the repair
  job recorded its payment shows `payment_method: unknown`.
- **Turning analytics on** also sends the last 3 days' orders, with their real
  times.

## Configuration

`POSTHOG_PROJECT_TOKEN` (the project token `phc_…`, the same one as the storefront)
and `POSTHOG_HOST` (`https://eu.i.posthog.com` by default, or the US host). Off
unless set.
