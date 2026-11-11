import { defineMiddlewares } from "@medusajs/framework/http"
import { creditNoteMiddlewares } from "./admin/credit-notes/middlewares"
import { orderCancellationMiddlewares } from "./admin/orders/middlewares"
import { returnRequestMiddlewares } from "./admin/return-requests/middlewares"
import { walletMiddlewares } from "./admin/wallets/middlewares"
import { storeCartMiddlewares } from "./store/carts/middlewares"
import { paymentHookMiddlewares } from "./hooks/middlewares"
import { redisGateMiddlewares } from "./redis-gate"
import { cartLeftoverMiddlewares } from "./store/carts/leftover-guard"
import { orderConfirmationMiddlewares } from "./admin/razorpay-confirmations/middlewares"

export default defineMiddlewares({
  routes: [
    // First, so a request that needs Redis fails fast while it is down.
    ...redisGateMiddlewares,
    // Then, before a cart changes, give back what a crashed attempt on it used up.
    ...cartLeftoverMiddlewares,
    // Razorpay signs the exact bytes it sends, so the raw body is kept to check them against.
    {
      method: ["POST"],
      matcher: "/webhooks/razorpay/payment-link-paid",
      bodyParser: { preserveRawBody: true },
    },
    ...walletMiddlewares,
    ...returnRequestMiddlewares,
    ...orderCancellationMiddlewares,
    ...storeCartMiddlewares,
    ...paymentHookMiddlewares,
    ...orderConfirmationMiddlewares,
    ...creditNoteMiddlewares,
  ],
})
