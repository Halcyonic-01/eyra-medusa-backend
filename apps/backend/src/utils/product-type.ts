/**
 * The product type name as the admin shows it ("Rings", "Pendants") turned into
 * the lower case single word the shipping weight table uses ("ring", "pendant").
 *
 * Case and a plural "s" do not matter, so a type added in the admin later does
 * not need a code change. "Necklaces" weigh like chains. A name it does not know
 * is passed on in lower case, and the storefront weighs it with its default.
 */
const SAME_AS: Record<string, string> = {
  necklace: "chain",
  bangle: "bracelet",
}

export function shipmentItemType(raw: string | null | undefined): string {
  const name = (raw ?? "").trim().toLowerCase()
  if (!name) {
    return "ring"
  }
  const single = name.replace(/s$/, "")
  return SAME_AS[single] ?? single
}
