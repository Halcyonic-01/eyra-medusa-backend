# Deploying eyra-medusa-backend to Railway

This repo is an npm-workspaces monorepo (`apps/backend` is the actual Medusa
app). All commands below assume Railway builds from the **repo root**, not
`apps/backend` — the workspace lockfile lives at the root, so installing from
inside `apps/backend` alone won't resolve correctly.

## 1. Push this repo to GitHub

```bash
cd ~/Documents/eyra-medusa-backend
git init
git add .
git commit -m "Initial Medusa v2 backend with Razorpay provider and EYRA seed script"
```

Create an empty repo on GitHub (no README/gitignore — this repo already has
them), then:

```bash
git remote add origin https://github.com/<you>/eyra-medusa-backend.git
git push -u origin main
```

## 2. Create the Railway service

In your `eyra-backend` Railway project (the one with the Postgres service
already added):

- **+ New** → **GitHub Repo** → select `eyra-medusa-backend`
- Leave **Root Directory** as `/` (the repo root)
- Under **Settings → Build**, set:
  - Build Command: `npm install && npm run build --workspace=apps/backend`
- Under **Settings → Deploy**, set:
  - Start Command: `npm run start --workspace=apps/backend`

## 3. Environment variables

Reference the Postgres service so the URL stays in sync automatically:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

Then add everything else from `apps/backend/.env.template` — CORS values,
`JWT_SECRET`/`COOKIE_SECRET` (generate with `openssl rand -hex 32`, a
different value for each), and the four `RAZORPAY_*` values (same test-mode
credentials already sitting in the frontend's `.env.local`).

`ADMIN_CORS` needs this service's own Railway domain — deploy once first to
get the domain (Settings → Networking → Generate Domain), then come back and
fill it in, then redeploy.

## 4. First-deploy setup

Once the service is live, open Railway's **shell** for this service (or run
these against `DATABASE_URL` via the Railway CLI locally) and run, in order:

```bash
npx medusa db:migrate
npx medusa user -e you@example.com -p <a-real-password>
npx medusa exec ./src/scripts/seed-eyra.ts
```

- `db:migrate` — creates all core Medusa tables plus the Razorpay plugin's own.
- `user` — creates your Admin dashboard login.
- `seed-eyra.ts` — creates the India/INR region, Razorpay + COD payment
  providers, warehouse, a placeholder ₹0 shipping option, and all 12 EYRA
  products with the exact shape the frontend expects.

**The seed script logs a publishable API key to the console when it runs —
copy that value.** That's your `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.

## 5. Point the frontend at this backend

On Vercel, update:

```
NEXT_PUBLIC_MEDUSA_BACKEND_URL = https://<this-service>.up.railway.app
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = <from step 4>
```

Redeploy the frontend.

## Known gaps to close before this is a real, working checkout

- **Price scaling bug in the frontend.** Medusa v2 stores/returns amounts in
  major units (₹2,499 as `2499`) — confirmed against the installed
  `@medusajs/pricing` Price model and Medusa's own demo seed script. The
  frontend's `lib/medusa.ts` and `lib/medusa-cart.ts` both divide Store API
  amounts by 100, assuming paise. Until that's fixed, every price will
  display as 1/100th of the real value, and worse — the Razorpay checkout
  amount is derived from that same (wrong) total, so real payments would
  undercharge by 100x. Needs fixing in the frontend before any real
  transaction.
- **Shipping cost is a ₹0 placeholder.** `serverTotals.shippingTotal` on the
  frontend reads directly from Medusa's own shipping option price — it does
  not currently pull a live Shiprocket rate. Real delivery pricing rules
  (flat fee, free-above-threshold, etc.) still need to be decided and wired
  into the shipping option here.
- **COD orders never call Medusa's `/complete`** on the frontend — flagged
  earlier, unrelated to this backend, but still open.
