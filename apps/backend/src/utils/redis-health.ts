import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { postToStorefront } from "./storefront"

/**
 * Whether Redis answers, checked every few seconds with a short timeout.
 *
 * Medusa's own Redis connections (event bus, workflow engine) are built to wait
 * for Redis forever, as BullMQ requires, so during an outage a checkout or a
 * webhook would hang instead of failing. The payment routes check this first
 * and answer 503 straight away while Redis is down; Razorpay and the storefront
 * retry. The team is told when Redis has been down for a while and when it is
 * back. The tracker is pure (ping and clock passed in) so it is unit tested.
 */
export type RedisState = "unknown" | "up" | "down"

export class RedisHealth {
  state: RedisState = "unknown"
  private downSince: number | null = null
  private alerted = false

  constructor(
    private readonly ping: () => Promise<unknown>,
    private readonly notify: (event: "down" | "recovered", downForMs: number) => void,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 1000,
    private readonly alertAfterMs = 30000
  ) {}

  async check(): Promise<RedisState> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs)
        }),
      ])
      this.markUp()
    } catch {
      this.markDown()
    } finally {
      if (timer) clearTimeout(timer)
    }
    return this.state
  }

  private markUp() {
    if (this.state === "down" && this.alerted) this.notify("recovered", this.now() - (this.downSince ?? this.now()))
    this.state = "up"
    this.downSince = null
    this.alerted = false
  }

  private markDown() {
    if (this.state !== "down") this.downSince = this.now()
    this.state = "down"
    const downFor = this.now() - (this.downSince ?? this.now())
    if (!this.alerted && downFor >= this.alertAfterMs) {
      this.alerted = true
      this.notify("down", downFor)
    }
  }
}

const CHECK_EVERY_MS = 2000
let shared: RedisHealth | null | undefined

/** The process-wide tracker, started on first use. Null when Redis is not configured or cannot be watched. */
export function redisHealth(container: MedusaContainer): RedisHealth | null {
  if (shared !== undefined) return shared
  shared = null
  if (!process.env.REDIS_URL) return shared
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const base = (container.resolve(Modules.EVENT_BUS) as { eventBusRedisConnection_?: { duplicate?: (o: object) => any } })
    .eventBusRedisConnection_
  if (!base?.duplicate) {
    logger.warn("[redis-health] the event bus is not on Redis; payment routes are not gated on Redis health")
    return shared
  }
  // A separate connection that gives up quickly, unlike Medusa's own.
  const client = base.duplicate({
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  })
  client.on("error", () => undefined)
  // Wait for the connection to be up (it is new, or reconnecting); the tracker's
  // timeout bounds the wait, so a Redis that does not come back reads as down.
  const ping = async () => {
    if (client.status !== "ready") {
      await new Promise((resolve) => client.once("ready", resolve))
    }
    return client.ping()
  }
  const tracker = new RedisHealth(
    ping,
    (event, downForMs) => {
      const seconds = Math.round(downForMs / 1000)
      if (event === "down") logger.error(`[redis-health] Redis has not answered for ${seconds} s; payment routes answer 503 until it is back`)
      else logger.warn(`[redis-health] Redis is answering again after ${seconds} s`)
      void postToStorefront("/api/ops/notify", { type: event === "down" ? "redis_down" : "redis_recovered", order_id: "-", seconds }, logger)
    }
  )
  setInterval(() => void tracker.check(), CHECK_EVERY_MS).unref()
  shared = tracker
  return shared
}

/** For tests: forget the tracker so the next call builds a new one. */
export function resetRedisHealthForTests() {
  shared = undefined
}
