import { redisModules, redisProblems } from "../redis-modules"

describe("redisModules", () => {
  it("adds the Redis event bus, workflow engine and locking when REDIS_URL is set", () => {
    const modules = redisModules({ REDIS_URL: "redis://r:6379" } as any)
    expect(modules.map((m) => m.resolve)).toEqual([
      "@medusajs/medusa/event-bus-redis",
      "@medusajs/medusa/workflow-engine-redis",
      "@medusajs/medusa/locking",
    ])
    expect(modules[0].options).toEqual({ redisUrl: "redis://r:6379" })
    expect(modules[1].options).toEqual({ redis: { redisUrl: "redis://r:6379" } })
    expect((modules[2].options as any).providers[0]).toMatchObject({
      resolve: "@medusajs/medusa/locking-redis",
      is_default: true,
      options: { redisUrl: "redis://r:6379" },
    })
  })

  it("adds nothing without REDIS_URL, including a blank one", () => {
    expect(redisModules({} as any)).toEqual([])
    expect(redisModules({ REDIS_URL: "" } as any)).toEqual([])
  })
})

describe("redisProblems", () => {
  it("warns only in production without Redis", () => {
    expect(redisProblems({ NODE_ENV: "production" } as any)).toHaveLength(1)
    expect(redisProblems({ NODE_ENV: "production", REDIS_URL: "redis://r" } as any)).toEqual([])
    expect(redisProblems({ NODE_ENV: "development" } as any)).toEqual([])
  })
})
