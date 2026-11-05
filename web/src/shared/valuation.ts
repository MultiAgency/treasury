import { useEffect, useMemo, useState } from "react";
import { displayedUsd } from "./prices";
import { nextValuationAt, scheduleValuation } from "./valuation-clock";
import type { Overview } from "../platform";

/**
 * The book valued at its prices while they're fresh, and the time it was valued at. Prices age even when a refresh
 * fails or a tab remains open: value again on new data, a future observation's timestamp, or a price's expiry.
 */
export function useValuedBook(raw: Overview): { data: Overview; now: number } {
  const [revision, setRevision] = useState(0);
  const now = useMemo(() => Date.now(), [raw, revision]);
  const next = nextValuationAt(raw.book, now);
  useEffect(() => scheduleValuation(next, () => setRevision(count => count + 1)), [next]);
  const data = useMemo(() => ({ ...raw, book: raw.book.map(h => ({ ...h, usd: displayedUsd(h, now) })) }), [raw, now]);
  return { data, now };
}
