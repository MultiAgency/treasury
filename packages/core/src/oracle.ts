// Price oracle, step 1 (A3.1): decide whether a set of quotes can be trusted, and if so what their median is.
// Pure and deterministic: the clock is passed in, nothing is read or fetched here. Anything missing, stale or
// disagreeing freezes the reading, so nothing downstream trades on it (fail closed).
//
// The EMA reference and the TWAP are the next step (A3.2). Defaults are the plan's source values, awaiting the
// backtest's calibration (H9); equality at a limit passes, since the plan says "over 2%" and "over 5 minutes".

export const ORACLE_DEFAULTS = {
  /** Fresh, distinct sources needed. */
  minSources: 3,
  /** Freeze when (max − min) / median is over this many percent. */
  maxDisagreementPct: 2,
  /** A quote older than this many milliseconds is stale. */
  maxStalenessMs: 5 * 60_000,
} as const;

export type OracleLimits = { minSources: number; maxDisagreementPct: number; maxStalenessMs: number };

export type PriceQuote = {
  source: string;
  asset: string;
  /** Price in USD. */
  price: number;
  /** Unix ms of the observation at the source. */
  observedAt: number;
};

export type FrozenReason = "insufficient-sources" | "stale" | "disagreement";

export type QuoteCheck =
  | { frozen: false; median: number; quotes: PriceQuote[] }
  | { frozen: true; reason: FrozenReason; detail: string; quotes: PriceQuote[] };

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Checks one asset's quotes at `now`.
 * - A quote counts only if it is for this asset, has a finite price above zero, and wasn't observed in the future.
 * - If a source appears twice, only its newest quote counts.
 * - A quote older than `maxStalenessMs` is stale and doesn't count.
 * - Fewer than `minSources` counted quotes freezes the reading (`stale` when stale quotes caused the shortfall,
 *   else `insufficient-sources`). Counted quotes more than `maxDisagreementPct` apart freeze it as `disagreement`.
 */
export function checkQuotes(asset: string, quotes: readonly PriceQuote[], now: number, limits: OracleLimits = ORACLE_DEFAULTS): QuoteCheck {
  const newest = new Map<string, PriceQuote>();
  for (const q of quotes) {
    if (q.asset !== asset || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.observedAt) || q.observedAt > now) continue;
    const seen = newest.get(q.source);
    if (!seen || q.observedAt > seen.observedAt) newest.set(q.source, q);
  }
  const valid = [...newest.values()];
  const fresh = valid.filter(q => now - q.observedAt <= limits.maxStalenessMs);

  if (fresh.length < limits.minSources) {
    const stale = valid.length - fresh.length;
    return {
      frozen: true,
      reason: stale > 0 && valid.length >= limits.minSources ? "stale" : "insufficient-sources",
      detail: `${fresh.length} fresh of ${limits.minSources} needed sources (${stale} stale)`,
      quotes: fresh,
    };
  }
  const mid = median(fresh.map(q => q.price));
  const prices = fresh.map(q => q.price);
  const spread = Math.max(...prices) - Math.min(...prices);
  // Compared without dividing, so a spread of exactly the limit passes: (max − min) × 100 over median × limit.
  if (spread * 100 > limits.maxDisagreementPct * mid) {
    return { frozen: true, reason: "disagreement", detail: `sources differ by ${((spread / mid) * 100).toFixed(2)}% (limit ${limits.maxDisagreementPct}%)`, quotes: fresh };
  }
  return { frozen: false, median: mid, quotes: fresh };
}
