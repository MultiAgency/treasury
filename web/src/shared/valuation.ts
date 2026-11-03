import { useEffect, useMemo, useState } from "react";
import { displayedUsd } from "./prices";
import type { Overview } from "../platform";

/**
 * The book valued at its prices while they're fresh, and the time it was valued at. Prices age even when a refresh
 * fails or a tab remains open: the book is valued again when new data arrives and when the next price expires.
 */
export function useValuedBook(raw: Overview): { data: Overview; now: number } {
  const [expired, setExpired] = useState(0);
  // The only moments the valuation can change: new data, or a price's expiry.
  const now = useMemo(() => Date.now(), [raw, expired]);
  const next = Math.min(...raw.book.map(h => Date.parse(h.priceExpiresAt ?? "")).filter(at => Number.isFinite(at) && at > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    // A price is stale from its expiry on; setTimeout's delay is capped at about 24.8 days.
    const timer = setTimeout(() => setExpired(count => count + 1), Math.min(next - Date.now() + 1, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [next]);
  const data = useMemo(() => ({ ...raw, book: raw.book.map(h => ({ ...h, usd: displayedUsd(h, now) })) }), [raw, now]);
  return { data, now };
}
