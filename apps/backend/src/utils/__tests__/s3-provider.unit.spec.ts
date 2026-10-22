import http from "node:http"
import type { AddressInfo } from "node:net"
import { S3FileService } from "@medusajs/file-s3/dist/services/s3-file"
import { resolveFileStorage } from "../file-storage"

/**
 * Runs Medusa's real S3 provider against a tiny in-process S3 stand-in, so the
 * options this project builds are proven to upload, read back and delete files.
 * It says nothing about a real AWS bucket's permissions.
 */

type Stored = { body: Buffer; headers: http.IncomingHttpHeaders }

function startFakeS3(): Promise<{ url: string; objects: Map<string, Stored>; close: () => Promise<void> }> {
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        objects,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

describe("Medusa S3 provider with this project's options", () => {
  let fake: Awaited<ReturnType<typeof startFakeS3>>
  let service: S3FileService

  beforeAll(async () => {
    fake = await startFakeS3()
    const storage = resolveFileStorage({
      S3_BUCKET: "eyra-media",
      S3_REGION: "ap-south-1",
      S3_FILE_URL: "https://eyra-media.s3.ap-south-1.amazonaws.com",
      S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
      S3_SECRET_ACCESS_KEY: "example-secret",
      S3_PREFIX: "eyra",
      S3_ENDPOINT: fake.url,
      S3_FORCE_PATH_STYLE: "true",
    })
    if (storage.kind !== "s3") throw new Error("expected S3")
    service = new S3FileService({ logger: { error: jest.fn(), info: jest.fn() } } as never, storage.options as never)
  })

  afterAll(async () => {
    await fake.close()
  })

  const pdf = Buffer.from("%PDF-1.4 test invoice")

  it("stores a private file under the prefix and reads it back", async () => {
    const saved = await service.upload({
      filename: "EYRA-26-27-00001.pdf",
      mimeType: "application/pdf",
      content: pdf.toString("base64"),
      access: "private",
    } as never)

    expect(saved.key.startsWith("eyra/EYRA-26-27-00001-")).toBe(true)
    expect(saved.key.endsWith(".pdf")).toBe(true)

    const stored = [...fake.objects.entries()].find(([path]) => path.endsWith(saved.key))
    expect(stored).toBeTruthy()
    expect(stored![1].headers["x-amz-acl"]).toBe("private")
    expect(stored![1].headers["content-type"]).toBe("application/pdf")

    const back = await service.getAsBuffer({ fileKey: saved.key } as never)
    expect(back.equals(pdf)).toBe(true)
  })

  it("stores a product image as public, with a URL on the configured file host", async () => {
    const saved = await service.upload({
      filename: "ring.jpg",
      mimeType: "image/jpeg",
      content: Buffer.from("jpeg-bytes").toString("base64"),
      access: "public",
    } as never)
    expect(saved.url.startsWith("https://eyra-media.s3.ap-south-1.amazonaws.com/")).toBe(true)
    const stored = [...fake.objects.entries()].find(([path]) => path.endsWith(saved.key))
    expect(stored![1].headers["x-amz-acl"]).toBe("public-read")
  })

  it("gives a short-lived signed link for a private file, not a public address", async () => {
    const saved = await service.upload({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      content: pdf.toString("base64"),
      access: "private",
    } as never)
    const link = await service.getPresignedDownloadUrl({ fileKey: saved.key } as never)
    const url = new URL(link)
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600)
    expect(link).not.toContain("example-secret")
  })

  it("deletes a file", async () => {
    const saved = await service.upload({
      filename: "temp.pdf",
      mimeType: "application/pdf",
      content: pdf.toString("base64"),
      access: "private",
    } as never)
    await service.delete({ fileKey: saved.key } as never)
    expect([...fake.objects.keys()].some((path) => path.endsWith(saved.key))).toBe(false)
  })

  it("refuses to start without both keys when keys are used", () => {
    expect(
      () =>
        new S3FileService({ logger: {} } as never, {
          authentication_method: "access-key",
          bucket: "b",
          region: "r",
          file_url: "https://x",
        } as never)
    ).toThrow(/Access key ID and secret access key are required/)
  })
})
