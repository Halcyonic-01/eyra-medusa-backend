import { MAX_PHOTO_BYTES, PHOTO_MIME_TYPES, type PhotoMimeType } from "./constants"

/** What the file really is, from its first bytes, whatever name or type it was sent with. */
export function sniffImage(bytes: Buffer): PhotoMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp"
  }
  return null
}

export type PhotoCheck = { ok: true; bytes: Buffer; mime: PhotoMimeType; size: number } | { ok: false; error: string }

/** A base64 photo: decodes, checks the size and that the bytes are a JPEG, PNG or WebP. */
export function checkPhoto(contentBase64: unknown): PhotoCheck {
  if (typeof contentBase64 !== "string" || !contentBase64) return { ok: false, error: "No photo was sent." }
  if (contentBase64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) {
    return { ok: false, error: "That photo is too large." }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) return { ok: false, error: "That photo could not be read." }
  const bytes = Buffer.from(contentBase64, "base64")
  if (bytes.length === 0) return { ok: false, error: "That photo is empty." }
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: "That photo is too large." }
  const mime = sniffImage(bytes)
  if (!mime || !(PHOTO_MIME_TYPES as readonly string[]).includes(mime)) {
    return { ok: false, error: "Please choose a JPEG, PNG or WebP photo." }
  }
  return { ok: true, bytes, mime, size: bytes.length }
}

export const photoExtension = (mime: PhotoMimeType): string =>
  mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"
