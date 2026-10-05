import { defineMiddlewares } from "@medusajs/framework/http"
import { returnRequestMiddlewares } from "./admin/return-requests/middlewares"
import { walletMiddlewares } from "./admin/wallets/middlewares"

export default defineMiddlewares({
  routes: [...walletMiddlewares, ...returnRequestMiddlewares],
})
