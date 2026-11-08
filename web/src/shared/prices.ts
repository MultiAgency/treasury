/** Price freshness and USD display for the Treasury app (app-owned; display only, never authorization). */
/** Valuation metadata. Missing or invalid timestamps never establish freshness. */
export type PriceObservation = { price: number | null; priceUpdatedAt: string | null; priceExpiresAt: string | null };

/** A complete displayed total cannot turn missing values into zero or overflow into infinity. */
export function totalUsd(book: readonly { usd: number | null }[]): number | null {
  let total = 0;
  for (const holding of book) {
    if (typeof holding.usd !== "number" || !Number.isFinite(holding.usd) || holding.usd < 0) return null;
    total += holding.usd;
  }
  return Number.isFinite(total) ? total : null;
}
export function priceState(value: PriceObservation, now: number): "fresh" | "stale" | "unavailable" {
  if (value.price === null || !Number.isFinite(value.price) || value.price <= 0) return "unavailable";
  const updated = Date.parse(value.priceUpdatedAt ?? ""), expires = Date.parse(value.priceExpiresAt ?? "");
  if (!Number.isFinite(updated) || !Number.isFinite(expires) || updated > now || expires <= updated) return "unavailable";
  return expires <= now ? "stale" : "fresh";
}

