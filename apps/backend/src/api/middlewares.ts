import { defineMiddlewares } from "@medusajs/framework/http"
import { creditNoteMiddlewares } from "./admin/credit-notes/middlewares"
import { orderCancellationMiddlewares } from "./admin/orders/middlewares"
import { returnRequestMiddlewares } from "./admin/return-requests/middlewares"
import { walletMiddlewares } from "./admin/wallets/middlewares"
import { storeCartMiddlewares } from "./store/carts/middlewares"

export default defineMiddlewares({
  routes: [
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
    ...creditNoteMiddlewares,
  ],
})
