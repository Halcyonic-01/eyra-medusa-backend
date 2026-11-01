# Customer emails

The backend decides **when** a customer email is due and makes sure it goes out **once**. The storefront owns the wording and the Resend account (`lib/email.ts` there), so there is no email key in this repository. Setup of Resend itself, the storefront variables and how to preview the emails are in the storefront README ("Customer emails (Resend)").

How the backend asks: `POST {STOREFRONT_REVALIDATE_URL origin}/api/wallet/notify` with the `x-revalidate-secret` header, the same call and secret the wallet and cancellation emails already use. Nothing new to configure except the optional switch below.

## What is sent, and from where

| Email | Trigger | Code |
| --- | --- | --- |
| Order shipped | the courier shipment is created | `finish-dispatch` step calls `emailOrderShipped` |
| Order delivered | Shiprocket reports DELIVERED | webhook route calls `emailOrderDelivered` (follow-up `delivered`) |
| Refund on its way | a returned parcel's online payment is refunded | `processReturnedParcel` calls `emailRtoRefund` |
| Welcome offer | a customer tagged `newsletter_subscriber` is created | `subscribers/send-welcome-offer.ts` |
| Promotion | staff run the campaign script | `scripts/send-promotion-email.ts` |

Already existing and unchanged: order confirmation (storefront), cancellation, wallet credit, declined request. Cancellation refunds are explained inside the cancellation email, and the wallet part of a returned-parcel refund has the wallet email, so neither gets a second refund email.

## Sent once

Order emails (`src/utils/customer-email.ts`):

1. The order remembers each email it has sent in its metadata, as `email_sent_<kind>` (`email_sent_shipped`, `email_sent_delivered`, `email_sent_rto_refund`). A repeat finds the marker and sends nothing.
2. Only a confirmed send writes the marker. If Resend or the storefront is down the marker is not written, so the next attempt can send it.
3. The storefront passes `<kind>:<order id>` to Resend as an `Idempotency-Key`, so two requests at the same instant still make one email.
4. A repeat of a DELIVERED update re-triggers the email only while the news is under 3 days old, so a failed delivery email can be retried by the courier's repeat without a replay of old news emailing anyone.

Nothing throws: a failed email is logged and never fails an order, a shipment or a courier update.

## Offers go only to people who asked

Subscribers are customers with `metadata.newsletter_subscriber = true`, which the storefront's signup form sets. Unsubscribing (the link in every offer email) sets it to `false`. Account holders who never signed up get no offers. The discount shown is read from `commerce-rules.ts`, so an email cannot advertise a code the cart does not honour.

The welcome offer is sent when the signup creates the customer, once (`metadata.welcome_offer_sent_at`). A person who already had an account and signs up later is not sent it.

### Running a campaign

```bash
cd apps/backend
npx medusa exec ./src/scripts/send-promotion-email.ts \
  campaign=diwali-2026 code=EYRA350 \
  subject="Diwali, with Rs 350 off" headline="A little sparkle for Diwali" \
  message="Our festive pieces are in. Use your code at checkout." \
  cta=/products ctaLabel="Shop the collection" limit=1
```

- With no `send=true` it only prints how many subscribers would get it.
- `send=true` sends. Each customer gets a campaign once (`metadata.promo_sent_<campaign>`), so a stopped run can be started again.
- `limit` caps the sends (default 50). It pauses between sends to stay under Resend's 2 requests a second.
- What really happens depends on the storefront the backend points at (`STOREFRONT_REVALIDATE_URL`): in test mode everything goes to the test address, in live mode it needs `EMAIL_PROMOTIONS_ENABLED=true` on the storefront. Always start with `limit=1`.

## Switching it off

`CUSTOMER_EMAILS_ENABLED=false` on the backend stops it asking for any of the emails above (shipped, delivered, refund, welcome, campaigns). Existing emails are not affected.

## Tests

```bash
cd apps/backend
npm run test:unit                                    # once-only rules, opt-in filtering, failure handling
DB_USERNAME=<user> DB_PASSWORD= npm run test:integration:http -- integration-tests/http/customer-emails
```

The integration specs run a real Medusa app against a fake storefront and cover: shipped on a real "Ship now"; delivered once for repeated courier updates; a failed email never blocking a shipment and being sent on the next try; old news not emailing; the refund email; the welcome offer for subscribers only.
