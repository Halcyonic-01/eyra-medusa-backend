import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createOrderWorkflow } from "@medusajs/medusa/core-flows"
import { ORDER_DISPATCH_MODULE } from "../modules/order-dispatch"

/**
 * Local development and end-to-end tests only. Makes an order for one product
 * that is shipped but not yet delivered, the way dispatch leaves it, and prints
 * what a test needs to deliver it through the Shiprocket webhook:
 *
 *   PRODUCT=luna-anklet npx medusa exec ./src/scripts/dev-review-fixture.ts
 *
 * Refuses to run in production. Nothing is sent to anyone.
 */
export default async function devReviewFixture({ container }: ExecArgs) {
  if (process.env.NODE_ENV === "production") throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "dev-review-fixture is for local development only")
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const handle = process.env.PRODUCT || "luna-anklet"

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "thumbnail", "sales_channels.id", "variants.id", "variants.title", "variants.prices.amount", "variants.prices.currency_code"],
    filters: { handle },
  })
  const product = products[0] as any
  if (!product) throw new MedusaError(MedusaError.Types.NOT_FOUND, `No product with handle ${handle}`)
  const variant = product.variants[0]
  const price = Number(variant.prices?.find((p: any) => p.currency_code === "inr")?.amount ?? variant.prices?.[0]?.amount ?? 1000)

  const { data: regions } = await query.graph({ entity: "region", fields: ["id", "currency_code"] })
  const region = (regions as any[]).find((r) => r.currency_code === "inr") ?? regions[0]

  const stamp = Date.now()
  const customers = container.resolve(Modules.CUSTOMER)
  // CUSTOMER_ID attaches the order to a customer that already exists, to try the signed-in screens.
  const existing = process.env.CUSTOMER_ID ? await customers.retrieveCustomer(process.env.CUSTOMER_ID) : undefined
  const email = existing?.email ?? `review-e2e-${stamp}@example.test`
  const customer = existing ?? (await customers.createCustomers({ email, first_name: "Asha", last_name: "Rao", has_account: true }))

  const { result: order } = await createOrderWorkflow(container).run({
    input: {
      region_id: (region as any).id,
      sales_channel_id: product.sales_channels?.[0]?.id,
      currency_code: "inr",
      email,
      customer_id: customer.id,
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
      items: [
        {
          variant_id: variant.id,
          title: product.title,
          product_title: product.title,
          variant_title: variant.title,
          thumbnail: product.thumbnail,
          quantity: 1,
          unit_price: price,
        },
      ],
      metadata: { review_e2e: true, whatsapp_opt_in: process.env.WHATSAPP === "yes" },
    } as any,
  })

  const awb = `AWBREVIEW${stamp}`
  await (container.resolve(ORDER_DISPATCH_MODULE) as any).createOrderDispatches({
    order_id: order.id,
    state: "shipped",
    window_ends_at: new Date(),
    shipped_at: new Date(),
    shiprocket_order_ref: `EYRA-${order.display_id}`,
    awb_code: awb,
  })
  // One line a test can read.
  process.stdout.write(`REVIEW_FIXTURE ${JSON.stringify({ order_id: order.id, display_id: order.display_id, awb, email, customer_id: customer.id })}\n`)
}
