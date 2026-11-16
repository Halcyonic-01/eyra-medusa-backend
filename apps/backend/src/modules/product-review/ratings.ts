export type RatingSummary = {
  /** The mean of approved ratings to one decimal, or 0 with no reviews. */
  average: number
  count: number
  /** How many approved reviews gave each number of stars. */
  breakdown: Record<"1" | "2" | "3" | "4" | "5", number>
}

/** Only from approved reviews: the caller passes nothing else. */
export function summarise(ratings: number[]): RatingSummary {
  const breakdown = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }
  let total = 0
  let count = 0
  for (const value of ratings) {
    const stars = Math.round(Number(value))
    if (stars < 1 || stars > 5) continue
    breakdown[String(stars) as keyof typeof breakdown] += 1
    total += stars
    count += 1
  }
  return { average: count ? Math.round((total / count) * 10) / 10 : 0, count, breakdown }
}

export const SORTS = ["newest", "highest", "lowest"] as const
export type ReviewSort = (typeof SORTS)[number]

/** The id is the last tie-breaker, so two reviews can never swap places between pages. */
export function sortOrder(sort: ReviewSort): Record<string, "ASC" | "DESC"> {
  if (sort === "highest") return { rating: "DESC", submitted_at: "DESC", id: "DESC" }
  if (sort === "lowest") return { rating: "ASC", submitted_at: "DESC", id: "DESC" }
  return { submitted_at: "DESC", id: "DESC" }
}
