# Product reviews

Verified reviews with star ratings, titles, text and photos. Only a customer
who bought and received a product can review it, every review is checked by
our team before it appears, and a product's rating is worked out only from
its approved reviews. The storefront side is in the storefront repository
(review page, product page section, emails, WhatsApp templates).

## The customer journey

1. Shiprocket reports the order **DELIVERED** (`/webhooks/shiprocket/order-update`).
   The delivered email goes out as before, and the review request is opened at
   once (`requestOrderReviewsWorkflow`): one `review_request` per order, with
   four `review_notification` rows (request and reminder, by email and WhatsApp).
2. The request is sent straight away: email always, WhatsApp only when the
   customer ticked the box at checkout (`whatsapp_opt_in` on the order) and the
   order has an Indian mobile number. Both carry the same private link,
   `https://<site>/review/<token>`.
3. The customer opens the link (no sign-in), rates each piece, writes a review,
   adds up to four photos and sends it. The link is then used up.
4. Three days after the request, if nothing came in, the **same link** goes
   again as a reminder (job `send-review-requests`, every 10 minutes). Sending a
   review first cancels the reminder.
5. The review waits in **Reviews** in the Medusa admin. Approving it publishes it
   on the product page with a Verified purchase badge and updates the product's
   `rating` and `review_count` (product metadata, read by the storefront).
6. Signed-in customers can also review, and edit their reviews, from
   **My orders > order > Rate & review**. An edit goes back to be checked.

## Rules that hold

- **Verified only.** A review is always tied to a delivered order line
  (`order_dispatch.delivered_at` set, not returned to sender, order not
  cancelled). The complimentary tote is never reviewable.
- **One review per customer per product** (unique index on product and
  customer). Buying again, or reviewing from the account, edits the same review.
- **Links are single use, expire after 30 days, and are never stored.** The
  token is HMAC-SHA256(`REVIEW_LINK_SECRET`, request id + nonce); only its
  sha256 is in the database. Issuing a new link (admin, order page) changes the
  nonce and retires the old one.
- **No duplicate messages.** One row per message (unique index), each sent under
  a lock and recorded before the lock is released. Email also carries a Resend
  idempotency key (`review_request:<order>`, `review_reminder:<order>`). A send
  whose result was never recorded is retried for email (Resend drops the
  repeat) but given up for WhatsApp, which has no such guard.
- **Failures are retried safely:** 15 minutes, 1 hour, 4 hours, 12 hours, then
  given up. Skipped (no consent, no phone, provider not set up) is final.
- **Negative reviews are published.** A rejection must name one of the published
  policy grounds (`REJECTION_REASONS`: spam, abusive, personal information, off
  topic, not genuine, inappropriate photo) and a note of at least 10
  characters. There is no ground for a low rating, and who rejected what and why
  is recorded on the review.
- **Spam signals** (links, contact details, abusive words, gibberish, all
  capitals, pasted text) are flagged for the moderator; they never reject a
  review on their own and never look at the rating. The storefront adds a
  hidden bot field and rate limits (Upstash) on submissions and uploads.
- **Photos:** the storefront checks the bytes (JPEG, PNG, WebP, HEIC), turns the
  photo upright, shrinks it to 1600px and re-encodes it as WebP, which strips the
  phone's location and camera data. The backend checks the bytes again (3 MB
  limit, 16 photos per order, 4 per review) and stores it with Medusa's file
  module (S3 in production). A photo can only be used on a review of its own order.
- **No made-up ratings.** The seed scripts no longer write ratings; run the reset
  script once on deploy (below).

## API

Store (publishable key):

| Route | What |
| --- | --- |
| `GET /store/product-reviews?handle=&sort=newest\|highest\|lowest&limit=&offset=` | Approved reviews, summary, star breakdown |
| `POST /store/review-links/session` `{ token }` | What the review page shows (404 for an unknown link) |
| `POST /store/review-links/reviews` `{ token, reviews[] }` | Send reviews with the link |
| `POST /store/review-links/photos` `{ token, content_base64 }` | Add a photo |
| `POST /store/carts/:id/whatsapp-consent` `{ opt_in }` | The checkout checkbox |

Admin (secret key or admin session):

| Route | What |
| --- | --- |
| `GET /admin/product-reviews?status=&rating=&product_id=&order_id=&flagged=&q=` | Moderation list |
| `POST /admin/product-reviews/moderate` `{ ids, action, reason?, note? }` | Approve or reject, one or many |
| `GET\|POST /admin/product-reviews/customer` | A signed-in customer's own reviews (called by the storefront after Clerk) |
| `POST /admin/product-reviews/customer/photos` | Their photo upload |
| `GET /admin/orders/:id/review-request` | Request and message status (order page widget) |
| `POST /admin/orders/:id/review-request/link` | A fresh link for support; nothing is sent |

## Production setup

1. Deploy the backend, then `npx medusa db:migrate` (module `productReview`).
2. Set `REVIEW_LINK_SECRET` (long random string). Optionally `REVIEW_LINK_BASE_URL`
   (defaults to the origin of `STOREFRONT_REVALIDATE_URL`, which must be the live site).
3. Clear the old made-up ratings once:
   `npx medusa exec ./src/scripts/reset-product-ratings.ts`
4. Shiprocket must call the delivered webhook (already set up for returns),
   with `SHIPROCKET_WEBHOOK_SECRET`.
5. On the storefront: Resend is already set up; for WhatsApp set
   `AISENSY_API_KEY` (and optionally `WHATSAPP_PROVIDER=aisensy`), and create and
   get approved two templates in AiSensy, `eyra_review_request` and
   `eyra_review_reminder`, each with `{{1}}` name, `{{2}}` product, `{{3}}` link,
   tied to the order and with no offers in them (so Meta can class them as
   utility, not marketing).

Local testing: `PRODUCT=luna-anklet npx medusa exec ./src/scripts/dev-review-fixture.ts`
makes a shipped order (refuses in production). Deliver it by posting the
Shiprocket webhook with the local secret, then get a link from the order page.
