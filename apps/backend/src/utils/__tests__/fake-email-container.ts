import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * A stand-in for the Medusa container with just what the email helpers use:
 * a logger, order and customer lookups, and the two update calls. It records
 * what was updated, so a test can tell whether an email was remembered.
 */
export type FakeOrder = {
  id: string
  customer_id?: string
  display_id: number
  email: string | null
  metadata: Record<string, unknown> | null
  shipping_address?: { first_name: string | null } | null
}
export type FakeCustomer = {
  id: string
  email: string | null
  first_name: string | null
  metadata: Record<string, unknown> | null
}

export function fakeEmailContainer(seed: { orders?: FakeOrder[]; customers?: FakeCustomer[] }) {
  const orders = seed.orders ?? []
  const customers = seed.customers ?? []
  const log: { info: string[]; error: string[] } = { info: [], error: [] }
  const orderUpdates: { id: string; metadata: Record<string, unknown> }[] = []
  const customerUpdates: { id: string; metadata: Record<string, unknown> }[] = []

  const query = {
    graph: async ({ entity, filters, pagination }: any) => {
      const rows: any[] = entity === "order" ? orders : customers
      const matching = rows.filter(
        (row) => (!filters?.id || row.id === filters.id) && (!filters?.customer_id || row.customer_id === filters.customer_id)
      )
      const skip = pagination?.skip ?? 0
      return { data: pagination ? matching.slice(skip, skip + pagination.take) : matching }
    },
  }

  const services: Record<string, unknown> = {
    [ContainerRegistrationKeys.LOGGER]: {
      info: (message: string) => log.info.push(message),
      error: (message: string) => log.error.push(message),
    },
    [ContainerRegistrationKeys.QUERY]: query,
    [Modules.ORDER]: {
      updateOrders: async (selector: { id: string }, data: { metadata: Record<string, unknown> }) => {
        orderUpdates.push({ id: selector.id, metadata: data.metadata })
        const order = orders.find((o) => o.id === selector.id)
        if (order) order.metadata = { ...(order.metadata ?? {}), ...data.metadata }
      },
    },
    [Modules.CUSTOMER]: {
      updateCustomers: async (id: string, data: { metadata: Record<string, unknown> }) => {
        customerUpdates.push({ id, metadata: data.metadata })
        const customer = customers.find((c) => c.id === id)
        if (customer) customer.metadata = data.metadata
      },
    },
  }

  return {
    container: { resolve: (key: string) => services[key] } as any,
    log,
    orderUpdates,
    customerUpdates,
  }
}

/** Replaces fetch with a recorder that answers each call from `reply`. */
export function fakeStorefront(reply: (path: string, body: any) => Response | Promise<Response>) {
  const calls: { path: string; body: any; secret: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input))
    const body = JSON.parse(init?.body ?? "{}")
    calls.push({ path: url.pathname, body, secret: init?.headers?.["x-revalidate-secret"] ?? null })
    return reply(url.pathname, body)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

export const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
