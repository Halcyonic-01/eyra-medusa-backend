/**
 * Where uploaded files live: product images from the Medusa admin and the
 * generated invoice PDFs.
 *
 * With the S3 settings present, files go to a persistent S3 bucket. Without
 * them Medusa keeps files on the server's own disk, which Railway wipes on every
 * deploy, so that is only for local development. This reads the settings from
 * the environment and never hard-codes a credential.
 *
 *   S3_BUCKET             bucket name
 *   S3_REGION             for example ap-south-1
 *   S3_FILE_URL           public base URL of the bucket or its CDN, no trailing slash,
 *                         for example https://my-bucket.s3.ap-south-1.amazonaws.com
 *   S3_ACCESS_KEY_ID      IAM access key (omit to use the IAM role / default AWS chain)
 *   S3_SECRET_ACCESS_KEY  IAM secret key
 *   S3_PREFIX             optional folder inside the bucket, for example "eyra/"
 *   S3_ENDPOINT           only for S3-compatible stores such as Cloudflare R2 or MinIO
 *   S3_FORCE_PATH_STYLE   "true" for MinIO and similar
 */

export type FileStorageEnv = Record<string, string | undefined>

export type S3ProviderOptions = {
  file_url: string
  bucket: string
  region: string
  authentication_method: "access-key" | "s3-iam-role"
  access_key_id?: string
  secret_access_key?: string
  prefix?: string
  endpoint?: string
  additional_client_config?: Record<string, unknown>
}

const clean = (value: string | undefined): string => (value ?? "").trim()

export type FileStorage =
  | { kind: "s3"; options: S3ProviderOptions }
  | { kind: "local" }

export class FileStorageConfigError extends Error {}

/**
 * Decides the storage from the environment. Nothing set means local disk. Some
 * of it set is a mistake, and is reported by name rather than quietly falling
 * back to a disk that loses files.
 */
export function resolveFileStorage(env: FileStorageEnv): FileStorage {
  const bucket = clean(env.S3_BUCKET)
  const region = clean(env.S3_REGION)
  const fileUrl = clean(env.S3_FILE_URL).replace(/\/+$/, "")
  const accessKey = clean(env.S3_ACCESS_KEY_ID)
  const secretKey = clean(env.S3_SECRET_ACCESS_KEY)

  if (!bucket && !region && !fileUrl && !accessKey && !secretKey) {
    return { kind: "local" }
  }

  const missing: string[] = []
  if (!bucket) missing.push("S3_BUCKET")
  if (!region) missing.push("S3_REGION")
  if (!fileUrl) missing.push("S3_FILE_URL")
  if (missing.length) {
    throw new FileStorageConfigError(
      `S3 file storage is partly configured. Also set: ${missing.join(", ")}.`
    )
  }
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    throw new FileStorageConfigError(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both left out to use an IAM role."
    )
  }
  if (!/^https?:\/\//i.test(fileUrl)) {
    throw new FileStorageConfigError("S3_FILE_URL must start with https:// (or http:// for local testing).")
  }

  const prefix = clean(env.S3_PREFIX)
  const endpoint = clean(env.S3_ENDPOINT)
  const pathStyle = clean(env.S3_FORCE_PATH_STYLE).toLowerCase() === "true"

  return {
    kind: "s3",
    options: {
      file_url: fileUrl,
      bucket,
      region,
      authentication_method: accessKey ? "access-key" : "s3-iam-role",
      ...(accessKey ? { access_key_id: accessKey, secret_access_key: secretKey } : {}),
      ...(prefix ? { prefix: prefix.endsWith("/") ? prefix : `${prefix}/` } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(pathStyle ? { additional_client_config: { forcePathStyle: true } } : {}),
    },
  }
}

/** The Medusa module entry for the chosen storage, or null to keep Medusa's default (local disk). */
export function fileModuleEntry(storage: FileStorage) {
  if (storage.kind === "local") return null
  return {
    resolve: "@medusajs/medusa/file",
    options: {
      providers: [
        {
          resolve: "@medusajs/medusa/file-s3",
          id: "s3",
          options: storage.options,
        },
      ],
    },
  }
}

/** What to tell the team when production would lose its files. Empty when all is well. */
export function fileStorageProblems(env: FileStorageEnv): string[] {
  let storage: FileStorage
  try {
    storage = resolveFileStorage(env)
  } catch (error) {
    return [(error as Error).message]
  }
  if (storage.kind === "local" && env.NODE_ENV === "production") {
    return [
      "File storage is not configured (S3_BUCKET, S3_REGION, S3_FILE_URL). Product images and invoice PDFs are kept on the server's disk and are lost on every deploy.",
    ]
  }
  return []
}
