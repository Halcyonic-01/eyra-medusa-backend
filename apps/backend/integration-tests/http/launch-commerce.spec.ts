import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { applyWalletToCartWorkflow } from "../../src/workflows/apply-wallet-to-cart"
import { issueWalletCreditWorkflow } from "../../src/workflows/issue-wallet-credit"
import { planShipment, SHIPMENT_ORDER_FIELDS } from "../../src/workflows/steps/build-shipment-request"
import { launchSetupIsNeeded, seedLaunchFixtures, type LaunchFixtures } from "./helpers/launch-fixtures"

// The Razorpay provider needs keys to start; nothing here calls Razorpay.
process.env.RAZORPAY_ID ??= "rzp_test_integration"
process.env.RAZORPAY_SECRET ??= "integration-secret"
process.env.RAZORPAY_WEBHOOK_SECRET ??= "integration-webhook"
process.env.RAZORPAY_ACCOUNT ??= "acc_integration"

// Keep the backend from calling a storefront that is not there.
process.env.STOREFRONT_REVALIDATE_URL = ""
process.env.STOREFRONT_REVALIDATE_SECRET = ""

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  disableAutoTeardown: true,
  testSuite: ({ api, getContainer }) => {
    describe("launch commerce rules", () => {
      let fx: LaunchFixtures
      let headers: Record<string, string>
      let seq = 0

      beforeAll(async () => {
        fx = await seedLaunchFixtures(getContainer())
        headers = { "x-publishable-api-key": fx.publishableKey }
      })

      const attempt = async (call: Promise<{ data: any }>) => {
        try {
          return { ok: true as const, data: (await call).data }
        } catch (error: any) {
          return { ok: false as const, status: error.response?.status, message: error.response?.data?.message as string }
        }
      }

      /** Throws with the server's own message, which axios hides by default. */
      const must = async <T>(call: Promise<{ data: T }>): Promise<T> => {
        try {
          return (await call).data
        } catch (error: any) {
          throw new Error(`${error.response?.status} ${JSON.stringify(error.response?.data)}`)
        }
      }

      const newCart = async (email?: string) => {
        const data: any = await must(
          api.post(
            "/store/carts",
            { region_id: fx.regionId, sales_channel_id: fx.salesChannelId, ...(email ? { email } : {}) },
            { headers }
          )
        )
        return data.cart.id as string
      }

      const addItem = (cartId: string, price: number, quantity = 1) =>
        must(api.post(`/store/carts/${cartId}/line-items`, { variant_id: fx.variantByPrice[price], quantity }, { headers }))

      const cartSummary = async (cartId: string) =>
        ((await must(api.get(`/store/carts/${cartId}/summary`, { headers }))) as any).cart

      const setMode = async (cartId: string, mode: "prepaid" | "cod") =>
        ((await must(api.post(`/store/carts/${cartId}/payment-mode`, { mode }, { headers }))) as any).cart

      const applyCode = (cartId: string, code: string | null) =>
        attempt(api.post(`/store/carts/${cartId}/discount-code`, { code }, { headers }))

      const cartWith = async (price: number, email?: string) => {
        const id = await newCart(email)
        await addItem(id, price)
        return id
      }

      const optionId = async (code: string) => {
        const query = getContainer().resolve("query")
        const { data } = await query.graph({ entity: "shipping_option", fields: ["id", "type.code"] })
        return data.find((option: any) => option.type?.code === code)!.id as string
      }

      const uniqueEmail = () => `shopper${++seq}@example.com`

      /** A signed-in shopper: an account exists for the email, and the cart carries it. */
      const accountCart = async (price: number) => {
        const email = uniqueEmail()
        await getContainer().resolve("customer").createCustomers({ email, has_account: true })
        const id = await newCart(email)
        await addItem(id, price)
        return { id, email }
      }

      it("has the setup in place", async () => {
        expect(await launchSetupIsNeeded(getContainer())).toBe(false)
      })

      describe("shipping and the Cash on Delivery charge", () => {
        it("makes prepaid orders free, with no code needed", async () => {
          const cart = await setMode(await cartWith(1000), "prepaid")
          expect(cart.payment_mode).toBe("prepaid")
          expect(cart.totals.shipping_total).toBe(0)
          expect(cart.totals.total).toBe(1000)
        })

        it("adds exactly Rs 99 for Cash on Delivery, once, however often it is set", async () => {
          const id = await cartWith(1000)
          let cart = await setMode(id, "cod")
          for (let i = 0; i < 3; i++) cart = await setMode(id, "cod")
          expect(cart.payment_mode).toBe("cod")
          expect(cart.totals.shipping_total).toBe(99)
          expect(cart.totals.total).toBe(1099)
        })

        it("recalculates when the payment method changes", async () => {
          const id = await cartWith(2000)
          expect((await setMode(id, "cod")).totals.total).toBe(2099)
          expect((await setMode(id, "prepaid")).totals.total).toBe(2000)
          expect((await setMode(id, "cod")).totals.total).toBe(2099)
          expect((await setMode(id, "prepaid")).totals.shipping_total).toBe(0)
        })

        it("keeps the discount and the charge separate", async () => {
          const { id } = await accountCart(3001)
          expect((await applyCode(id, "EYRA350")).ok).toBe(true)
          const cart = await setMode(id, "cod")
          expect(cart.totals.items_subtotal).toBe(3001)
          expect(cart.totals.discount_total).toBe(350)
          expect(cart.totals.shipping_total).toBe(99)
          expect(cart.totals.total).toBe(3001 - 350 + 99)
        })

        it("refuses an unknown payment mode", async () => {
          const result = await attempt(
            api.post(`/store/carts/${await cartWith(1000)}/payment-mode`, { mode: "free" }, { headers })
          )
          expect(result.ok).toBe(false)
          expect((result as any).status).toBe(400)
        })
      })

      /** Fills in the address and puts a Cash on Delivery payment on the cart, as the storefront does. */
      const readyForCod = async (cartId: string, email: string) => {
        await must(
          api.post(
            `/store/carts/${cartId}`,
            {
              email,
              shipping_address: {
                first_name: "Asha",
                last_name: "Rao",
                phone: "9999999999",
                address_1: "12 Lake Road",
                city: "Pune",
                province: "Maharashtra",
                postal_code: "411001",
                country_code: "in",
              },
            },
            { headers }
          )
        )
        const collection: any = await must(api.post("/store/payment-collections", { cart_id: cartId }, { headers }))
        await must(
          api.post(
            `/store/payment-collections/${collection.payment_collection.id}/payment-sessions`,
            { provider_id: "pp_system_default" },
            { headers }
          )
        )
      }

      const complete = (cartId: string) => attempt(api.post(`/store/carts/${cartId}/complete`, {}, { headers }))

      const readOrder = async (orderId: string) => {
        const query = getContainer().resolve("query")
        const { data } = await query.graph({
          entity: "order",
          fields: [
            "id",
            "total",
            "item_subtotal",
            "discount_total",
            "shipping_total",
            "items.*",
            "shipping_methods.*",
            "promotions.code",
          ],
          filters: { id: orderId },
        })
        return data[0] as any
      }

      describe("placing the order", () => {
        it("saves a COD order with the charge and the discount, and a total that matches the cart", async () => {
          const { id, email } = await accountCart(3500)
          expect((await applyCode(id, "EYRA350")).ok).toBe(true)
          const cart = await setMode(id, "cod")
          expect(cart.totals.total).toBe(3500 - 350 + 99)

          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(true)
          expect(result.data.type).toBe("order")

          const order = await readOrder(result.data.order.id)
          expect(Number(order.total)).toBe(cart.totals.total)
          expect(Number(order.item_subtotal)).toBe(3500)
          expect(Number(order.discount_total)).toBe(350)
          expect(Number(order.shipping_total)).toBe(99)
          expect(order.shipping_methods).toHaveLength(1)
          expect(order.shipping_methods[0].name).toBe("Cash on Delivery")
          expect(order.promotions.map((promotion: any) => promotion.code)).toEqual(["EYRA350"])

          // Only the product is on the order: there is no tote line, free or otherwise.
          expect(order.items).toHaveLength(1)
          expect(order.items[0].title).toBe("Probe")

          // What the courier is asked for: the courier collects the full COD amount.
          const query = getContainer().resolve("query")
          const { data: shipped } = await query.graph({
            entity: "order",
            fields: SHIPMENT_ORDER_FIELDS,
            filters: { id: result.data.order.id },
          })
          const plan: any = planShipment(shipped[0] as any)
          expect(plan.action === "ship" || plan.action === "stop").toBe(true)
          if (plan.action === "ship") {
            expect(plan.request.paymentMethod).toBe("cod")
            expect(plan.request.subtotal).toBe(3500 - 350 + 99)
            expect(plan.request.discount).toBe(350)
            expect(plan.request.shippingCharge).toBe(99)
            expect(plan.request.items).toHaveLength(1)
            expect(plan.request.items[0].price).toBe(3500)
          } else {
            // The test address has no phone on the order record in some Medusa versions.
            throw new Error(`shipment was not planned: ${plan.detail}`)
          }
        })

        it("refuses a COD order that skipped the COD charge", async () => {
          const { id, email } = await accountCart(1000)
          await setMode(id, "prepaid")
          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/Cash on Delivery charge/)
        })

        it("refuses an order with no shipping method at all", async () => {
          const { id, email } = await accountCart(1000)
          await readyForCod(id, email)
          expect((await complete(id) as any).ok).toBe(false)
        })

        it("an order cut below a code's minimum does not keep the code", async () => {
          const { id, email } = await accountCart(2000)
          await addItem(id, 1600)
          expect((await applyCode(id, "EYRA350")).ok).toBe(true)
          await setMode(id, "cod")
          const before = await cartSummary(id)
          expect(before.promo_codes).toEqual(["EYRA350"])

          // Straight to Medusa, as a bypass attempt would: the code no longer fits.
          const big = before.items.find((item: any) => item.unit_price === 2000)
          await must(api.delete(`/store/carts/${id}/line-items/${big.id}`, { headers }))
          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(true)

          const order = await readOrder(result.data.order.id)
          expect(order.promotions).toHaveLength(0)
          expect(Number(order.discount_total)).toBe(0)
          expect(Number(order.total)).toBe(1600 + 99)
        })

        it("places an order the wallet pays for in full as prepaid, with free shipping", async () => {
          const { id, email } = await accountCart(1000)
          const query = getContainer().resolve("query")
          const { data: customers } = await query.graph({ entity: "customer", fields: ["id"], filters: { email } })
          const customerId = customers[0].id as string

          await issueWalletCreditWorkflow(getContainer()).run({
            input: { customer_id: customerId, amount: 5000, reason: "return" },
          })
          await setMode(id, "prepaid")
          await applyWalletToCartWorkflow(getContainer()).run({ input: { cart_id: id, customer_id: customerId } })

          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(true)

          const order = await readOrder(result.data.order.id)
          expect(order.shipping_methods).toHaveLength(1)
          expect(order.shipping_methods[0].name).toBe("Free shipping (prepaid)")
          expect(Number(order.shipping_total)).toBe(0)
        })

        it("does not let a wallet-covered order carry the COD charge", async () => {
          const { id, email } = await accountCart(1000)
          const query = getContainer().resolve("query")
          const { data: customers } = await query.graph({ entity: "customer", fields: ["id"], filters: { email } })
          const customerId = customers[0].id as string

          await issueWalletCreditWorkflow(getContainer()).run({
            input: { customer_id: customerId, amount: 5000, reason: "return" },
          })
          await setMode(id, "cod")
          await applyWalletToCartWorkflow(getContainer()).run({ input: { cart_id: id, customer_id: customerId } })

          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/complimentary shipping/i)
        })

        it("lets WELCOME200 be used once per account, and again by a different account", async () => {
          const first = await accountCart(2000)
          expect((await applyCode(first.id, "WELCOME200")).ok).toBe(true)
          await setMode(first.id, "cod")
          await readyForCod(first.id, first.email)
          expect(((await complete(first.id)) as any).ok).toBe(true)

          // The same account, a new cart.
          const again = await newCart(first.email)
          await addItem(again, 2000)
          const refused: any = await applyCode(again, "WELCOME200")
          expect(refused.ok).toBe(false)
          expect(refused.message).toMatch(/already been used/)
          expect((await cartSummary(again)).promo_codes).toEqual([])

          // Someone else is not affected.
          const other = await accountCart(2000)
          expect((await applyCode(other.id, "WELCOME200")).ok).toBe(true)
        })
      })

      describe("discount codes", () => {
        const expectDiscount = async (code: string, price: number, discount: number) => {
          const { id } = await accountCart(price)
          const result = await applyCode(id, code)
          if (discount === 0) {
            expect(result.ok).toBe(false)
            const cart = await cartSummary(id)
            expect(cart.totals.discount_total).toBe(0)
            expect(cart.promo_codes).toEqual([])
          } else {
            expect(result.ok).toBe(true)
            const cart = (result as any).data.cart
            expect(cart.totals.discount_total).toBe(discount)
            expect(cart.totals.total).toBe(price - discount)
            expect(cart.promo_codes).toEqual([code])
          }
        }

        // Every code is judged on its own minimum only, with no upper limit.
        it.each([
          ["WELCOME200", 1499, 0],
          ["WELCOME200", 1500, 200],
          ["WELCOME200", 2999, 200],
          ["WELCOME200", 3000, 200],
          ["WELCOME200", 3001, 200],
          ["WELCOME200", 5001, 200],
          ["WELCOME200", 12000, 200],
          ["EYRA350", 2999, 0],
          ["EYRA350", 3000, 0],
          ["EYRA350", 3001, 350],
          ["EYRA350", 5000, 350],
          ["EYRA350", 5001, 350],
          ["EYRA350", 12000, 350],
          ["EYRA650", 3001, 0],
          ["EYRA650", 5000, 0],
          ["EYRA650", 5001, 650],
          ["EYRA650", 12000, 650],
        ])("%s on %i takes off %i", async (code, price, discount) => {
          await expectDiscount(code as string, price as number, discount as number)
        })

        it("says why a code does not fit", async () => {
          const { id } = await accountCart(1499)
          const result: any = await applyCode(id, "WELCOME200")
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/above ₹1,499/)
        })

        it("refuses retired and made-up codes, and FREESHIP", async () => {
          const { id } = await accountCart(2000)
          for (const code of ["WELCOME10", "LAUNCH20", "FREESHIP", "NOPE"]) {
            const result: any = await applyCode(id, code)
            expect(result.ok).toBe(false)
          }
          expect((await cartSummary(id)).promo_codes).toEqual([])
        })

        it("lets a new code replace the old one, never stack", async () => {
          const { id } = await accountCart(3500)
          expect((await applyCode(id, "EYRA350")).ok).toBe(true)
          const second: any = await applyCode(id, "EYRA350")
          expect(second.ok).toBe(true)
          expect(second.data.cart.promo_codes).toEqual(["EYRA350"])
          const removed: any = await applyCode(id, null)
          expect(removed.ok).toBe(true)
          expect(removed.data.cart.promo_codes).toEqual([])
          expect(removed.data.cart.totals.discount_total).toBe(0)
        })

        it("applies only the codes that fit when several are put on the cart directly", async () => {
          const { id } = await accountCart(2999)
          await api.post(`/store/carts/${id}/promotions`, { promo_codes: ["WELCOME200", "EYRA350", "EYRA650"] }, { headers })
          const cart = await cartSummary(id)
          // 2,999 is above only WELCOME200's minimum, so only that one stays on.
          expect(cart.promo_codes).toEqual(["WELCOME200"])
          expect(cart.totals.discount_total).toBe(200)
        })

        it("refuses to place an order that carries two codes, when both fit", async () => {
          const { id, email } = await accountCart(6000)
          await api.post(`/store/carts/${id}/promotions`, { promo_codes: ["EYRA350", "EYRA650"] }, { headers })
          await setMode(id, "cod")
          await readyForCod(id, email)
          const result: any = await complete(id)
          expect(result.ok).toBe(false)
          expect(JSON.stringify(result)).toMatch(/Only one discount code/)
        })

        it("drops a code by itself when the order stops fitting it", async () => {
          const { id } = await accountCart(3000)
          await addItem(id, 1500)
          expect((await applyCode(id, "EYRA350")).ok).toBe(true)

          let cart = await cartSummary(id)
          expect(cart.promo_codes).toEqual(["EYRA350"])
          const big = cart.items.find((item: any) => item.unit_price === 3000)
          // Straight to Medusa: only the 1,500 item is left, which EYRA350 does not fit.
          await api.delete(`/store/carts/${id}/line-items/${big.id}`, { headers })
          cart = await cartSummary(id)
          expect(cart.totals.items_subtotal).toBe(1500)
          expect(cart.promo_codes).toEqual([])
          expect(cart.totals.discount_total).toBe(0)
        })

        it("refuses WELCOME200 without an account", async () => {
          const id = await cartWith(2000)
          const result: any = await applyCode(id, "WELCOME200")
          expect(result.ok).toBe(false)
          expect(result.message).toMatch(/Sign in/)
        })

        it("lets EYRA350 and EYRA650 be used by guests and again and again", async () => {
          for (let i = 0; i < 3; i++) {
            expect((await applyCode(await cartWith(4000, uniqueEmail()), "EYRA350")).ok).toBe(true)
            expect((await applyCode(await cartWith(6000, uniqueEmail()), "EYRA650")).ok).toBe(true)
          }
        })
      })
    })
  },
})
