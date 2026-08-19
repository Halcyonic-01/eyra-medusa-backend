import { loadEnv, defineConfig, Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // Optional — Medusa falls back to an in-memory event bus/workflow engine
    // when unset, which is fine for a single-instance deployment like this one.
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    // Railway serves this behind a single public domain — disable Medusa's
    // separate admin dev-server assumptions and let it mount at /app.
    disable: process.env.DISABLE_MEDUSA_ADMIN === 'true',
  },
  plugins: ['medusa-plugin-razorpay-v2'],
  modules: [
    {
      resolve: '@medusajs/medusa/payment',
      dependencies: [Modules.PAYMENT, ContainerRegistrationKeys.LOGGER],
      options: {
        providers: [
          {
            resolve: 'medusa-plugin-razorpay-v2/providers/payment-razorpay/src',
            // id must stay "razorpay" — Medusa derives the provider ID as
            // pp_<id>_<id>, and the EYRA frontend hardcodes pp_razorpay_razorpay
            // in app/api/razorpay/create-order/route.ts.
            id: 'razorpay',
            options: {
              key_id: process.env.RAZORPAY_TEST_KEY_ID ?? process.env.RAZORPAY_ID,
              key_secret: process.env.RAZORPAY_TEST_KEY_SECRET ?? process.env.RAZORPAY_SECRET,
              razorpay_account: process.env.RAZORPAY_TEST_ACCOUNT ?? process.env.RAZORPAY_ACCOUNT,
              // Auto-cancel an unpaid Razorpay order after this many minutes
              // (12 min–30 days). Keeps stale carts from lingering as "pending".
              automatic_expiry_period: 30,
              manual_expiry_period: 20,
              refund_speed: 'normal',
              webhook_secret:
                process.env.RAZORPAY_TEST_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET,
            },
          },
        ],
      },
    },
    {
      resolve: '@medusajs/medusa/fulfillment',
      options: {
        providers: [
          {
            resolve: './src/modules/shiprocket-fulfillment',
            id: 'shiprocket',
            options: {
              apiToken: process.env.SHIPROCKET_API_TOKEN,
              pickupPincode: process.env.SHIPROCKET_PICKUP_PINCODE,
              // Applied whenever Shiprocket is unconfigured or unreachable —
              // keeps checkout from hard-failing on a rate-lookup outage.
              fallbackRate: Number(process.env.SHIPPING_FALLBACK_RATE ?? 79),
            },
          },
        ],
      },
    },
  ],
})
