import crypto from "node:crypto"
import http from "node:http"

/**
 * A stand-in for PayU's merchant API (postservice: verify_payment,
 * cancel_refund_transaction, check_action_status). It checks every command's
 * hash with its own copy of PayU's documented formula, so a wrong hash in the
 * backend fails here. Tests decide what the customer did and can take PayU down.
 */

export const FAKE_PAYU_KEY = "fakeKey"
export const FAKE_PAYU_SALT = "fakeSalt"

const sha512 = (text: string) => crypto.createHash("sha512").update(text).digest("hex")

export type FakeTxn = {
  txnid: string
  mihpayid: string
  amount: string
  status: "success" | "failure" | "pending"
  unmappedstatus: string
}

export type FakePayuRefund = { request_id: string; mihpayid: string; token: string; amount: string; status: string }

export function createFakePayu() {
  const txns = new Map<string, FakeTxn>()
  const refunds: FakePayuRefund[] = []
  const calls: { command: string; vars: string[] }[] = []
  const state = { down: false, refund: "ok" as "ok" | "refuse" | "lost", seq: 0 }

  function handle(params: URLSearchParams): { status: number; body: unknown } {
    if (state.down) return { status: 503, body: { error: "down" } }
    const command = params.get("command") ?? ""
    const vars = [1, 2, 3, 4, 5].map((n) => params.get(`var${n}`)).filter((v): v is string => v !== null)
    calls.push({ command, vars })
    const expected = sha512([params.get("key"), command, params.get("var1") ?? "", FAKE_PAYU_SALT].join("|"))
    if (params.get("key") !== FAKE_PAYU_KEY || params.get("hash") !== expected) {
      return { status: 200, body: { status: 0, msg: "Invalid Hash." } }
    }
    if (command === "verify_payment") {
      const txnid = params.get("var1") ?? ""
      const txn = txns.get(txnid)
      if (!txn) {
        return { status: 200, body: { status: 0, msg: "0 out of 1 Transactions Fetched Successfully", transaction_details: { [txnid]: { mihpayid: "Not Found", status: "Not Found" } } } }
      }
      return {
        status: 200,
        body: {
          status: 1,
          msg: "1 out of 1 Transactions Fetched Successfully",
          transaction_details: { [txnid]: { mihpayid: txn.mihpayid, txnid, amt: txn.amount, transaction_amount: txn.amount, status: txn.status, unmappedstatus: txn.unmappedstatus } },
        },
      }
    }
    if (command === "cancel_refund_transaction") {
      const [mihpayid, token, amount] = [params.get("var1") ?? "", params.get("var2") ?? "", params.get("var3") ?? ""]
      if (state.refund === "refuse") return { status: 200, body: { status: 0, msg: "Refund request failed" } }
      if (refunds.some((r) => r.token === token)) return { status: 200, body: { status: 0, msg: "token already used or request pending" } }
      if (![...txns.values()].some((t) => t.mihpayid === mihpayid)) return { status: 200, body: { status: 0, msg: "transaction not exists" } }
      const refund = { request_id: `${++state.seq}000`, mihpayid, token, amount, status: "queued" }
      refunds.push(refund)
      if (state.refund === "lost") return { status: 504, body: "gateway timeout" }
      return { status: 200, body: { status: 1, msg: "Refund Request Queued", request_id: refund.request_id, mihpayid } }
    }
    if (command === "check_action_status") {
      const mihpayid = params.get("var1") ?? ""
      const mine = refunds.filter((r) => r.mihpayid === mihpayid)
      if (!mine.length) return { status: 200, body: { status: 0, msg: "0 out of 1 Transactions Fetched Successfully", transaction_details: { [mihpayid]: "No action status found" } } }
      return {
        status: 200,
        body: {
          status: 1,
          msg: "1 out of 1 Transactions Fetched Successfully",
          transaction_details: {
            [mihpayid]: Object.fromEntries(mine.map((r) => [r.request_id, { mihpayid, request_id: r.request_id, amt: r.amount, action: "refund", token: r.token, status: r.status }])),
          },
        },
      }
    }
    return { status: 200, body: { status: 0, msg: "Unknown command" } }
  }

  /** The customer paying (or failing) a transaction at PayU. */
  const pay = (txnid: string, amount: string, outcome: "success" | "failure" | "pending" = "success") => {
    const txn: FakeTxn = {
      txnid,
      mihpayid: txns.get(txnid)?.mihpayid ?? `40${Date.now()}${++state.seq}`,
      amount,
      status: outcome,
      unmappedstatus: outcome === "success" ? "captured" : outcome === "pending" ? "pending" : "failed",
    }
    txns.set(txnid, txn)
    return txn
  }

  /** What PayU posts to surl/furl (and webhooks) for a transaction, signed with the documented reverse hash. */
  const response = (fields: { txnid: string; amount: string; status: string; email: string; firstname: string; productinfo: string; udf1?: string; mihpayid?: string }, salt = FAKE_PAYU_SALT) => {
    const udf = [fields.udf1 ?? "", "", "", "", ""]
    const hash = sha512(
      [salt, fields.status, "", "", "", "", "", udf[4], udf[3], udf[2], udf[1], udf[0], fields.email, fields.firstname, fields.productinfo, fields.amount, fields.txnid, FAKE_PAYU_KEY].join("|")
    )
    return { key: FAKE_PAYU_KEY, ...fields, udf1: udf[0], udf2: "", udf3: "", udf4: "", udf5: "", hash, mihpayid: fields.mihpayid ?? txns.get(fields.txnid)?.mihpayid ?? "" }
  }

  /** Answers fetch calls made to the fake's URL without a server (unit tests). */
  const fetchHandler = (url: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!target.startsWith(url)) throw new Error(`unexpected fetch to ${target}`)
    const { status, body } = handle(new URLSearchParams(String(init?.body ?? "")))
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }

  return { txns, refunds, calls, state, handle, pay, response, fetchHandler }
}

/** The fake as an HTTP server (integration tests); point PAYU_API_URL at the returned url. */
export async function startFakePayu(port: number) {
  const fake = createFakePayu()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const { status, body } = fake.handle(new URLSearchParams(Buffer.concat(chunks).toString()))
      res.writeHead(status, { "Content-Type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body))
    })
  })
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done()))
  return {
    ...fake,
    url: `http://127.0.0.1:${port}/merchant/postservice.php?form=2`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
