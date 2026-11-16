import http from "node:http"

export type Stored = { body: Buffer; headers: http.IncomingHttpHeaders }

/** A tiny in-process S3 stand-in: PUT, GET and DELETE of objects, path style. */
export function startFakeS3(port: number): Promise<{ objects: Map<string, Stored>; close: () => Promise<void> }> {
  const objects = new Map<string, Stored>()
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").split("?")[0])
    if (req.method === "PUT") {
      const chunks: Buffer[] = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => {
        objects.set(key, { body: Buffer.concat(chunks), headers: req.headers })
        res.writeHead(200, { ETag: '"fake"' }).end()
      })
      return
    }
    if (req.method === "GET") {
      const found = objects.get(key)
      if (!found) return void res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>")
      res.writeHead(200, { "Content-Length": found.body.length }).end(found.body)
      return
    }
    if (req.method === "DELETE") {
      objects.delete(key)
      return void res.writeHead(204).end()
    }
    res.writeHead(405).end()
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ objects, close: () => new Promise((done) => server.close(() => done())) })
    )
  })
}

export type StorefrontBehaviour = {
  /** What the invoice render route answers. */
  mode: "ok" | "down" | "gstin_missing" | "draft"
  /** Invoice number the fake stamps on its PDF (defaults to the order's own). */
  numberOverride?: string
}

/**
 * A stand-in for the storefront's /api/invoices/render. It counts how often it
 * is asked, so tests can prove a PDF is drawn once and not again.
 */
export function startFakeStorefront(
  port: number,
  secret: string,
  orderNumbers: Map<string, string>
): Promise<{ calls: { order_id: string; allow_unverified: boolean }[]; behaviour: StorefrontBehaviour; close: () => Promise<void> }> {
  const calls: { order_id: string; allow_unverified: boolean }[] = []
  const behaviour: StorefrontBehaviour = { mode: "ok" }

  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body))
    const given = req.headers["x-shipment-secret"] ?? req.headers["x-revalidate-secret"]
    if (given !== secret) return json(401, { error: "Unauthorized" })

    if (req.url?.startsWith("/api/invoices/render") && req.method === "POST") {
      const chunks: Buffer[] = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { order_id: string; allow_unverified?: boolean }
        calls.push({ order_id: body.order_id, allow_unverified: body.allow_unverified === true })

        if (behaviour.mode === "down") return json(500, { error: "render_failed", message: "The PDF could not be drawn." })
        if (behaviour.mode === "gstin_missing" && body.allow_unverified !== true) {
          return json(422, { error: "invoice_not_valid", message: "The seller's GSTIN is not set (SELLER_GSTIN)." })
        }
        const number = behaviour.numberOverride ?? orderNumbers.get(body.order_id) ?? "EYRA/26-27/00001"
        const text = `%PDF-1.3\n% fake invoice for ${number}\n${"x".repeat(200)}\n%%EOF\n`
        const bytes = Buffer.from(text)
        return json(200, {
          filename: `${number.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`,
          invoice_number: number,
          sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
          unverified: behaviour.mode === "draft" || (behaviour.mode === "gstin_missing" && body.allow_unverified === true),
          pdf_base64: bytes.toString("base64"),
        })
      })
      return
    }
    json(404, { error: "not found" })
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ calls, behaviour, close: () => new Promise((done) => server.close(() => done())) })
    )
  })
}

export type RazorpayBehaviour = { paymentLink: "ok" | "fail" | "reject_contact" }
export type RazorpayCall = { path: string; method: string; body: any }
export type FakeLink = { id: string; status: string; amount: number; amount_paid: number; payments: { payment_id: string; status: string }[] }

/**
 * A stand-in for Razorpay's REST API: it makes payment links, reports them, and
 * cancels them, and records what it was asked. A test pays or expires a link
 * with `links.get(id)` and changing it, as if the customer had acted.
 */
export function startFakeRazorpay(port: number) {
  const calls: RazorpayCall[] = []
  const behaviour: RazorpayBehaviour = { paymentLink: "ok" }
  const links = new Map<string, FakeLink>()
  let seq = 0
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body))
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body: any = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      } catch {
        body = {}
      }
      calls.push({ path: req.url ?? "", method: req.method ?? "", body })
      if (req.method === "POST" && req.url === "/payment_links") {
        if (behaviour.paymentLink === "fail") return json(400, { error: { description: "The amount is invalid" } })
        // As Razorpay does for a phone like 9999999999.
        if (behaviour.paymentLink === "reject_contact" && body.customer?.contact) {
          return json(400, { error: { description: "Recurring digits in customer contact are disallowed" } })
        }
        seq += 1
        const link: FakeLink = { id: `plink_FAKE${seq}`, status: "created", amount: body.amount, amount_paid: 0, payments: [] }
        links.set(link.id, link)
        return json(200, { ...link, short_url: `https://rzp.io/i/fake${seq}` })
      }
      const cancel = /^\/payment_links\/([^/]+)\/cancel$/.exec(req.url ?? "")
      if (req.method === "POST" && cancel) {
        const link = links.get(cancel[1])
        if (!link) return json(404, { error: { description: "not found" } })
        if (link.status === "paid") return json(400, { error: { description: "Payment link cannot be cancelled as it is already paid" } })
        link.status = "cancelled"
        return json(200, link)
      }
      const read = /^\/payment_links\/([^/]+)$/.exec(req.url ?? "")
      if (req.method === "GET" && read) {
        const link = links.get(read[1])
        return link ? json(200, link) : json(404, { error: { description: "not found" } })
      }
      json(404, { error: { description: "not found" } })
    })
  })
  return new Promise<{
    calls: RazorpayCall[]
    behaviour: RazorpayBehaviour
    links: Map<string, FakeLink>
    close: () => Promise<void>
  }>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ calls, behaviour, links, close: () => new Promise((done) => server.close(() => done())) }))
  })
}
