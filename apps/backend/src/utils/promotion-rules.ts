/**
 * Brings a discount code's order-value rules in line with the table in
 * commerce-rules.ts. The setup script only creates a code the first time, so a
 * database made earlier keeps the rules it was made with. This works out what
 * has to change, without touching Medusa, so it can be tested alone.
 */

export type DesiredRule = {
  attribute: string
  operator: "gt" | "gte" | "lt" | "lte"
  values: string[]
}

export type ExistingRule = {
  id: string
  attribute?: string | null
  operator?: string | null
  values?: ({ value?: string | null } | string)[] | null
}

export type RulePlan = {
  /** Rules that no longer belong, such as an old upper limit. */
  remove: string[]
  /** Rules that are there but with the wrong operator or amount. */
  update: { id: string; operator: DesiredRule["operator"]; values: string[] }[]
  /** Rules that are missing. */
  add: DesiredRule[]
}

const valuesOf = (rule: ExistingRule): string[] =>
  (rule.values ?? []).map((entry) => String(typeof entry === "string" ? entry : entry?.value ?? ""))

const sameValues = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => Number(value) === Number(b[index]))

/**
 * Only rules on `item_subtotal` are managed here. Anything else on the code,
 * for example a rule someone added in the admin on another attribute, is left alone.
 */
export function planPromotionRuleSync(desired: readonly DesiredRule[], existing: readonly ExistingRule[]): RulePlan {
  const plan: RulePlan = { remove: [], update: [], add: [] }
  const managed = existing.filter((rule) => rule.attribute === "item_subtotal")
  const claimed = new Set<string>()

  for (const want of desired) {
    const exact = managed.find(
      (rule) => !claimed.has(rule.id) && rule.operator === want.operator && sameValues(valuesOf(rule), want.values)
    )
    if (exact) {
      claimed.add(exact.id)
      continue
    }
    // A rule that points the same way (a minimum stays a minimum) just has its amount or strictness changed.
    const sameDirection = managed.find(
      (rule) => !claimed.has(rule.id) && isLower(rule.operator) === isLower(want.operator)
    )
    if (sameDirection) {
      claimed.add(sameDirection.id)
      plan.update.push({ id: sameDirection.id, operator: want.operator, values: want.values })
    } else {
      plan.add.push(want)
    }
  }

  for (const rule of managed) {
    if (!claimed.has(rule.id)) plan.remove.push(rule.id)
  }
  return plan
}

/** "gt"/"gte" set a minimum; "lt"/"lte" set a maximum. */
function isLower(operator: string | null | undefined): boolean {
  return operator === "gt" || operator === "gte"
}

export const planIsEmpty = (plan: RulePlan): boolean =>
  plan.remove.length === 0 && plan.update.length === 0 && plan.add.length === 0
