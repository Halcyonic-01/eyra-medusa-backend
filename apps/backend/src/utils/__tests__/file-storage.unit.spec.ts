import {
  FileStorageConfigError,
  fileModuleEntry,
  fileStorageProblems,
  resolveFileStorage,
} from "../file-storage"

const full = {
  S3_BUCKET: "eyra-media",
  S3_REGION: "ap-south-1",
  S3_FILE_URL: "https://eyra-media.s3.ap-south-1.amazonaws.com/",
  S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  S3_SECRET_ACCESS_KEY: "example-secret",
}

describe("resolveFileStorage", () => {
  it("keeps local disk when nothing is set", () => {
    expect(resolveFileStorage({})).toEqual({ kind: "local" })
    expect(fileModuleEntry(resolveFileStorage({}))).toBeNull()
  })

  it("builds the S3 provider options from the environment", () => {
    const storage = resolveFileStorage({ ...full, S3_PREFIX: "eyra" })
    expect(storage.kind).toBe("s3")
    if (storage.kind !== "s3") return
    expect(storage.options).toMatchObject({
      file_url: "https://eyra-media.s3.ap-south-1.amazonaws.com", // trailing slash removed
      bucket: "eyra-media",
      region: "ap-south-1",
      authentication_method: "access-key",
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "example-secret",
      prefix: "eyra/",
    })
  })

  it("uses the IAM role when no keys are given", () => {
    const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ...noKeys } = full
    void S3_ACCESS_KEY_ID
    void S3_SECRET_ACCESS_KEY
    const storage = resolveFileStorage(noKeys)
    expect(storage.kind === "s3" && storage.options.authentication_method).toBe("s3-iam-role")
    expect(storage.kind === "s3" && "access_key_id" in storage.options).toBe(false)
  })

  it("names what is missing when it is only partly set", () => {
    expect(() => resolveFileStorage({ S3_BUCKET: "eyra-media" })).toThrow(/S3_REGION, S3_FILE_URL/)
    expect(() => resolveFileStorage({ ...full, S3_SECRET_ACCESS_KEY: "" })).toThrow(FileStorageConfigError)
    expect(() => resolveFileStorage({ ...full, S3_FILE_URL: "bucket.example.com" })).toThrow(/https/)
  })

  it("never puts the secret in an error message", () => {
    try {
      resolveFileStorage({ ...full, S3_BUCKET: "" })
    } catch (error) {
      expect((error as Error).message).not.toContain("example-secret")
      expect((error as Error).message).not.toContain("AKIAEXAMPLE")
    }
  })

  it("supports S3-compatible stores with a path-style endpoint", () => {
    const storage = resolveFileStorage({ ...full, S3_ENDPOINT: "http://localhost:4566", S3_FORCE_PATH_STYLE: "true" })
    expect(storage.kind === "s3" && storage.options.endpoint).toBe("http://localhost:4566")
    expect(storage.kind === "s3" && storage.options.additional_client_config).toEqual({ forcePathStyle: true })
  })

  it("produces a file module entry that uses the official S3 provider", () => {
    const entry = fileModuleEntry(resolveFileStorage(full))
    expect(entry?.resolve).toBe("@medusajs/medusa/file")
    expect(entry?.options.providers[0].resolve).toBe("@medusajs/medusa/file-s3")
    expect(entry?.options.providers[0].id).toBe("s3")
  })
})

describe("fileStorageProblems", () => {
  it("warns only in production, and only when files would be lost", () => {
    expect(fileStorageProblems({ NODE_ENV: "development" })).toEqual([])
    expect(fileStorageProblems({ NODE_ENV: "production" })).toHaveLength(1)
    expect(fileStorageProblems({ NODE_ENV: "production", ...full })).toEqual([])
  })

  it("reports a half-finished setup in any environment", () => {
    expect(fileStorageProblems({ S3_BUCKET: "x" })[0]).toMatch(/partly configured/)
  })
})
