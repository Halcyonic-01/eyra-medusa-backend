/**
 * Medusa's Redis-backed modules. Setting `projectConfig.redisUrl` alone does
 * not switch any of them on: without these entries Medusa keeps an in-memory
 * event bus, workflow engine and lock, which lose queued webhook events on a
 * restart and only lock within one process. Returned only when REDIS_URL is
 * set, so local development keeps working without Redis.
 *
 * What Redis does and does not fix: events (such as Razorpay's webhook, which
 * Medusa processes after a delay) survive a restart and are retried; locks and
 * scheduled jobs hold across instances. A workflow that dies part-way, such as
 * a cart completion, is NOT resumed by Medusa; the reconcile-order-payments job
 * and the dispatch payment check cover that.
 */
export function redisModules(env: NodeJS.ProcessEnv = process.env) {
  const redisUrl = env.REDIS_URL || ""
  if (!redisUrl) return []
  return [
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: { redisUrl },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: { redis: { redisUrl } },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: { redisUrl },
          },
        ],
      },
    },
  ]
}

/** Problems to show staff when production runs without Redis. */
export function redisProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production" || env.REDIS_URL) return []
  return [
    "REDIS_URL is not set: events, workflows and locks run in memory, so a restart can lose Razorpay webhook events and two server instances do not share locks",
  ]
}
