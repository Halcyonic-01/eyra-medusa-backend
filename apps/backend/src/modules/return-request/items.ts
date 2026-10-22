/** One line of a return or exchange request, as stored. */
export type RequestedItem = {
  item_id: string
  title: string
  quantity: number
  unit_price: number
  /** What the customer paid for these units, GST included, after their share of any discount. */
  total: number
  variant_title?: string | null
  sku?: string | null
}

// Medusa types a JSON column as an object, but the items are a list.

export function toStoredItems(items: RequestedItem[]): Record<string, unknown> {
  return items as unknown as Record<string, unknown>
}

export function fromStoredItems(stored: unknown): RequestedItem[] {
  return Array.isArray(stored) ? (stored as RequestedItem[]) : []
}
