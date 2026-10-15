/** The USD budget's three windows, as the provider reports each: its limit (null: unlimited) and what is left. Pure, shared with the web. */
type Window = { limit_usd: string | null; remaining_usd: string | null };

/** The USD budget window that refuses first: the limited one with the least left, as the provider checks every window. */
export function bindingWindow<W extends Window>(budget: Record<"daily" | "weekly" | "monthly", W>) {
  return (["daily", "weekly", "monthly"] as const)
    .map((period) => ({ period, ...budget[period] }))
    .filter((w) => w.limit_usd !== null)
    .sort((a, b) => Number(a.remaining_usd ?? Infinity) - Number(b.remaining_usd ?? Infinity))[0];
}
