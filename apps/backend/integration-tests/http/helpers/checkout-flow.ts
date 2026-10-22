import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import type { LaunchFixtures } from "./launch-fixtures"

type Api = { get: (...args: any[]) => Promise<any>; post: (...args: any[]) => Promise<any>; delete: (...args: any[]) => Promise<any> }

/** The checkout steps the storefront takes, driven through the real HTTP routes. */
export function checkoutFlow(api: Api, getContainer: () => MedusaContainer, fx: LaunchFixtures) {
  const headers = { "x-publishable-api-key": fx.publishableKey }
  let seq = 0

  const must = async (call: Promise<{ data: any }>) => {
    try {
      return (await call).data
    } catch (error: any) {
      throw new Error(`${error.response?.status} ${JSON.stringify(error.response?.data)}`)
    }
  }

  const attempt = async (call: Promise<{ data: any }>) => {
    try {
      return { ok: true as const, data: (await call).data }
    } catch (error: any) {
      return { ok: false as const, status: error.response?.status as number, message: error.response?.data?.message as string, body: error.response?.data }
    }
  }

  return {
    headers,
    must,
    attempt,

    /** A new customer with an account. */
    async customer() {
      const email = `flow${Date.now()}${++seq}@example.com`
      const created = await getContainer().resolve(Modules.CUSTOMER).createCustomers({ email, has_account: true })
      return { id: created.id as string, email }
    },

    async cart(email: string, items: { variantId: string; quantity?: number }[]) {
      const data = await must(
        api.post("/store/carts", { region_id: fx.regionId, sales_channel_id: fx.salesChannelId, email }, { headers })
      )
      const id = data.cart.id as string
      for (const item of items) {
        await must(api.post(`/store/carts/${id}/line-items`, { variant_id: item.variantId, quantity: item.quantity ?? 1 }, { headers }))
      }
      return id
    },

    applyCode: (cartId: string, code: string | null) =>
      attempt(api.post(`/store/carts/${cartId}/discount-code`, { code }, { headers })),

    async setMode(cartId: string, mode: "prepaid" | "cod") {
      return (await must(api.post(`/store/carts/${cartId}/payment-mode`, { mode }, { headers }))).cart
    },

    /** What the storefront calls after every cart change: puts the complimentary tote right. */
    async reconcile(cartId: string) {
      const data = await must(api.post(`/store/carts/${cartId}/reconcile`, {}, { headers }))
      return data as { cart: any; tote_status: string }
    },

    async removeLine(cartId: string, lineId: string) {
      await must(api.delete(`/store/carts/${cartId}/line-items/${lineId}`, { headers }))
    },

    async summary(cartId: string) {
      return (await must(api.get(`/store/carts/${cartId}/summary`, { headers }))).cart
    },

    /** Cash on Delivery: address, payment session, complete. Returns the order id. */
    async placeCod(cartId: string, email: string, province = "Maharashtra"): Promise<string> {
      await must(
        api.post(
          `/store/carts/${cartId}`,
          {
            email,
            shipping_address: {
              first_name: "Asha", last_name: "Rao", phone: "9999999999", address_1: "12 Lake Road",
              city: "Pune", province, postal_code: "411001", country_code: "in",
            },
          },
          { headers }
        )
      )
      const collection = await must(api.post("/store/payment-collections", { cart_id: cartId }, { headers }))
      await must(
        api.post(
          `/store/payment-collections/${collection.payment_collection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          { headers }
        )
      )
      const done = await must(api.post(`/store/carts/${cartId}/complete`, {}, { headers }))
      return done.order.id as string
    },
  }
}
