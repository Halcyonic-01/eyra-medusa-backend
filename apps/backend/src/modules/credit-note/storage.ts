import { S3FileService } from "@medusajs/file-s3/dist/services/s3-file"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { resolveFileStorage } from "../../utils/file-storage"
import { creditNoteFileName, creditNoteFolder } from "./config"

/**
 * Where credit note PDFs are kept. With S3 set up they go to their own folder in
 * the bucket, credit-notes/FY26-27/, as private files (no public address). In
 * development, without S3, they use Medusa's file service like invoices do.
 * Optional CREDIT_NOTE_S3_BUCKET puts them in a bucket of their own, using the
 * same region and credentials; CREDIT_NOTE_S3_PREFIX changes the folder.
 *
 * The stored reference starts with where it lives ("s3:" or "file:") so it can
 * be read back the same way, whatever the settings are later.
 */

function s3Service(container: MedusaContainer, folder: string): S3FileService | null {
  const storage = resolveFileStorage(process.env)
  if (storage.kind !== "s3") return null
  const options = {
    ...storage.options,
    ...(process.env.CREDIT_NOTE_S3_BUCKET?.trim() ? { bucket: process.env.CREDIT_NOTE_S3_BUCKET.trim() } : {}),
    // The folder is added to the bucket-wide prefix, if there is one.
    prefix: `${storage.options.prefix ?? ""}${folder}`,
  }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  return new S3FileService({ logger } as never, options as never)
}

export async function storeCreditNotePdf(
  container: MedusaContainer,
  input: { number: string; fy: string; bytes: Buffer }
): Promise<{ key: string }> {
  const filename = creditNoteFileName(input.number)
  const s3 = s3Service(container, creditNoteFolder(input.fy))
  if (s3) {
    const saved = await s3.upload({
      filename,
      mimeType: "application/pdf",
      content: input.bytes.toString("base64"),
      access: "private",
    } as never)
    return { key: `s3:${saved.key}` }
  }
  const [file] = await container.resolve(Modules.FILE).createFiles([
    { filename, mimeType: "application/pdf", content: input.bytes.toString("base64"), access: "private" },
  ])
  return { key: `file:${file.id}` }
}

export async function readCreditNotePdf(container: MedusaContainer, key: string, fy: string): Promise<Buffer | null> {
  try {
    if (key.startsWith("s3:")) {
      const s3 = s3Service(container, creditNoteFolder(fy))
      if (!s3) return null
      return Buffer.from(await s3.getAsBuffer({ fileKey: key.slice(3) } as never))
    }
    if (key.startsWith("file:")) {
      return Buffer.from(await container.resolve(Modules.FILE).getAsBuffer(key.slice(5)))
    }
  } catch {
    return null
  }
  return null
}

export async function deleteCreditNotePdf(container: MedusaContainer, key: string, fy: string): Promise<void> {
  try {
    if (key.startsWith("s3:")) {
      await s3Service(container, creditNoteFolder(fy))?.delete({ fileKey: key.slice(3) } as never)
    } else if (key.startsWith("file:")) {
      await container.resolve(Modules.FILE).deleteFiles([key.slice(5)])
    }
  } catch {
    // A stray file is harmless; the record is what matters.
  }
}

/** Keeps a month's GSTR-1 credit note feed as a private file in the gstr1/ folder. Returns where it went. */
export async function storeGstr1Csv(container: MedusaContainer, month: string, csv: string): Promise<{ key: string }> {
  const filename = `gstr1-credit-notes-${month}.csv`
  const content = Buffer.from(csv, "utf8").toString("base64")
  const s3 = s3Service(container, "gstr1/")
  if (s3) {
    const saved = await s3.upload({ filename, mimeType: "text/csv", content, access: "private" } as never)
    return { key: `s3:${saved.key}` }
  }
  const [file] = await container.resolve(Modules.FILE).createFiles([{ filename, mimeType: "text/csv", content, access: "private" }])
  return { key: `file:${file.id}` }
}
