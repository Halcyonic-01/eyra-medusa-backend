import { createHash } from "node:crypto"
import http from "node:http"

export type FakeStorefrontBehaviour = {
  /** What /api/credit-notes/render answers. */
  creditNote: "ok" | "down" | "wrong_number"
  /** What /api/returns/reverse-pickup answers. */
  reversePickup: "ok" | "fail"
  /** What /api/whatsapp/send answers. */
  whatsapp: "ok" | "down"
  /** What /api/wallet/notify answers: sent, or the email provider refused it. */
  email: "ok" | "down"
}

export type FakeStorefrontCall = { path: string; body: any; secret: string | undefined }

/**
 * A stand-in for the storefront's server routes that the backend calls: drawing
 * credit notes, booking reverse pickups, WhatsApp messages and team alerts. It
 * records every call, and each answer can be switched, so tests can prove what
 * the backend does when the storefront works and when it does not.
 */
export function startFakeStorefront(port: number, secret: string, sharedSecret = "integration-shared-secret") {
  const calls: FakeStorefrontCall[] = []
  const behaviour: FakeStorefrontBehaviour = { creditNote: "ok", reversePickup: "ok", whatsapp: "ok", email: "ok" }
  let reverseSeq = 0
  let shipmentSeq = 0

  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body))
    const given = (req.headers["x-shipment-secret"] ?? req.headers["x-revalidate-secret"]) as string | undefined
    // callStorefront sends the shipment secret; postToStorefront sends the shared one.
    if (given !== secret && given !== sharedSecret) return json(401, { error: "Unauthorized" })

    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body: any = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      } catch {
        body = {}
      }
      const path = (req.url ?? "").split("?")[0]
      calls.push({ path, body, secret: given })

      if (path === "/api/credit-notes/render") {
        if (behaviour.creditNote === "down") return json(500, { error: "render_failed", message: "The PDF could not be drawn." })
        const note = body.credit_note
        const number = behaviour.creditNote === "wrong_number" ? "CN/00-00/9999" : note?.credit_note_number
        const bytes = Buffer.from(`%PDF-1.3\n% fake credit note ${number}\n${"x".repeat(200)}\n%%EOF\n`)
        return json(200, {
          filename: `${String(number).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`,
          credit_note_number: number,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          pdf_base64: bytes.toString("base64"),
        })
      }

      if (path === "/api/returns/reverse-pickup") {
        if (behaviour.reversePickup === "fail") return json(502, { success: false, error: "Shiprocket refused the return order" })
        reverseSeq += 1
        return json(200, {
          success: true,
          reverse_order_ref: body.reverse_order_ref,
          shiprocket_order_id: `SR-REV-${reverseSeq}`,
          shipment_id: `SHIP-REV-${reverseSeq}`,
          awb_code: `AWBREV${reverseSeq}`,
        })
      }

      if (path === "/api/whatsapp/send") {
        if (behaviour.whatsapp === "down") return json(502, { sent: false, error: "provider_down" })
        return json(200, { sent: true })
      }

      if (path === "/api/wallet/notify") {
        return json(200, { sent: behaviour.email === "ok" })
      }

      if (path === "/api/shipping/create-shipment") {
        shipmentSeq += 1
        return json(200, {
          success: true,
          shipmentId: `SHIP-NEW-${shipmentSeq}`,
          shiprocketOrderId: `SR-NEW-${shipmentSeq}`,
          awbCode: `AWBNEW${shipmentSeq}`,
          courierName: "Delhivery",
          labelUrl: "https://labels.example/label.pdf",
          pickupScheduled: true,
        })
      }

      return json(200, { ok: true })
    })
  })

  return new Promise<{
    calls: FakeStorefrontCall[]
    behaviour: FakeStorefrontBehaviour
    callsTo: (path: string) => FakeStorefrontCall[]
    close: () => Promise<void>
  }>((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        calls,
        behaviour,
        callsTo: (path) => calls.filter((call) => call.path === path),
        close: () => new Promise((done) => server.close(() => done())),
      })
    )
  })
}
