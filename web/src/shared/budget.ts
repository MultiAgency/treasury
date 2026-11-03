export const PERIOD = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const;

/** The USD budget's windows, as the provider reports each: its limit (null: unlimited) and what is left. */
type Window = { limit_usd: string | null; remaining_usd: string | null };

/** The USD budget window that refuses first: the limited one with the least left, as the provider checks every window. */
export function bindingWindow<W extends Window>(budget: Record<keyof typeof PERIOD, W>) {
  return (Object.keys(PERIOD) as (keyof typeof PERIOD)[])
    .map((period) => ({ period, ...budget[period] }))
    .filter((w) => w.limit_usd !== null)
    .sort((a, b) => Number(a.remaining_usd ?? Infinity) - Number(b.remaining_usd ?? Infinity))[0];
}
