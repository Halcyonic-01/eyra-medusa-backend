import http from "node:http"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export type FakeOrder = {
  id: string
  entity: "order"
  amount: number
  amount_paid: number
  amount_due: number
  currency: string
  status: "created" | "attempted" | "paid"
  notes: Record<string, unknown>
}

export type FakePayment = {
  id: string
  entity: "payment"
  order_id: string
  amount: number
  currency: string
  status: "captured" | "authorized" | "failed" | "refunded"
}

const REAL_HOST = "https://api.razorpay.com"

/**
 * An in-process stand-in for the parts of Razorpay checkout uses: orders,
 * their payments, notes edits and refunds. Tests decide what the customer did
 * (paid in full, paid short, failed) and can take Razorpay down.
 */
export async function startFakeRazorpay(port: number) {
  const orders = new Map<string, FakeOrder>()
  const payments = new Map<string, FakePayment[]>()
  const refunds: { payment_id: string; amount: number }[] = []
  const state = { down: false, seq: 0 }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const json = (status: number, body: unknown) =>
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body))
      if (state.down) return json(503, { error: { code: "SERVER_ERROR" } })
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {}
      const path = (req.url ?? "").split("?")[0]
      let match: RegExpMatchArray | null

      if (req.method === "POST" && path === "/v1/orders") {
        state.seq += 1
        const order: FakeOrder = {
          id: `order_FAKE${state.seq}${Date.now()}`,
          entity: "order",
          amount: Number(body.amount),
          amount_paid: 0,
          amount_due: Number(body.amount),
          currency: String(body.currency ?? "INR"),
          status: "created",
          notes: body.notes ?? {},
        }
        orders.set(order.id, order)
        return json(200, order)
      }
      if ((match = path.match(/^\/v1\/orders\/([^/]+)\/payments$/)) && req.method === "GET") {
        if (!orders.has(match[1])) return json(400, { error: { code: "BAD_REQUEST_ERROR" } })
        const items = payments.get(match[1]) ?? []
        return json(200, { entity: "collection", count: items.length, items })
      }
      if ((match = path.match(/^\/v1\/orders\/([^/]+)$/))) {
        const order = orders.get(match[1])
        if (!order) return json(404, { error: { code: "BAD_REQUEST_ERROR", description: "not found" } })
        if (req.method === "PATCH") order.notes = { ...order.notes, ...(body.notes ?? {}) }
        return json(200, order)
      }
      if ((match = path.match(/^\/v1\/payments\/([^/]+)\/refund$/)) && req.method === "POST") {
        refunds.push({ payment_id: match[1], amount: Number(body.amount) })
        for (const list of payments.values()) {
          for (const payment of list) if (payment.id === match[1]) payment.status = "refunded"
        }
        return json(200, { id: `rfnd_FAKE${refunds.length}`, entity: "refund", payment_id: match[1], amount: body.amount })
      }
      return json(404, { error: { code: "NOT_FOUND", path } })
    })
  })

  await new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done()))
  const base = `http://127.0.0.1:${port}`

  // The backend's own Razorpay reads use fetch; send them here instead.
  const realFetch = global.fetch
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return realFetch(url.startsWith(REAL_HOST) ? base + url.slice(REAL_HOST.length) : input, init)
  }) as typeof fetch)

  /** Records a payment against an order, as the customer paying in the Razorpay window would. */
  const pay = (orderId: string, options: { amount?: number; status?: FakePayment["status"] } = {}) => {
    const order = orders.get(orderId)
    if (!order) throw new Error(`fake razorpay has no order ${orderId}`)
    const payment: FakePayment = {
      id: `pay_FAKE${++state.seq}`,
      entity: "payment",
      order_id: orderId,
      amount: options.amount ?? order.amount,
      currency: order.currency,
      status: options.status ?? "captured",
    }
    payments.set(orderId, [...(payments.get(orderId) ?? []), payment])
    const paid = (payments.get(orderId) ?? [])
      .filter((p) => p.status === "captured" || p.status === "authorized")
      .reduce((sum, p) => sum + p.amount, 0)
    order.amount_paid = paid
    order.amount_due = Math.max(order.amount - paid, 0)
    order.status = paid >= order.amount ? "paid" : "attempted"
    return payment
  }

  return {
    orders,
    payments,
    refunds,
    state,
    pay,
    /** Points the Razorpay plugin's own client (axios) at this fake. Call once the app is up. */
    attach(container: MedusaContainer) {
      const paymentModule = container.resolve(Modules.PAYMENT) as any
      const provider = paymentModule.paymentProviderService_.retrieveProvider("pp_razorpay_razorpay")
      provider.razorpay_.api.rq.defaults.baseURL = base
    },
    async close() {
      fetchSpy.mockRestore()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
