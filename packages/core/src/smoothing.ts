// Smoothing for the oracle (A3.2): the 15-minute TWAP and the 30-day EMA reference, over a history of price samples.
// Pure: the history and the clock are passed in. Samples are the oracle's own medians, one per reading.

export type Sample = { at: number; price: number };

/**
 * Keeps usable samples (finite, price above zero, not in the future), oldest first, one per timestamp. Two prices at
 * one instant are ambiguous, so that instant is dropped: keeping either would make the result depend on input order.
 */
export function cleanSamples(samples: readonly Sample[], now: number): Sample[] {
  const byTime = new Map<number, Sample | null>();
  for (const s of samples) {
    if (!(Number.isFinite(s.at) && Number.isFinite(s.price) && s.price > 0 && s.at <= now)) continue;
    const seen = byTime.get(s.at);
    byTime.set(s.at, seen === undefined || (seen !== null && seen.price === s.price) ? s : null);
  }
  return [...byTime.values()].filter((s): s is Sample => s !== null).sort((a, b) => a.at - b.at);
}

/**
 * Time-weighted average price over the last `windowMs` up to `now`. Each sample's price holds until the next sample
 * (the last one until `now`). Returns null when the history doesn't reach back to the start of the window, so a short
 * history is never averaged as if it were complete.
 */
export function twap(samples: readonly Sample[], now: number, windowMs: number): number | null {
  if (!(Number.isFinite(windowMs) && windowMs > 0)) return null;
  const start = now - windowMs;
  const clean = cleanSamples(samples, now);
  let price: number | undefined;
  let area = 0;
  let t = start;
  for (const s of clean) {
    if (s.at <= start) { price = s.price; continue; }
    if (price === undefined) return null;
    area += price * (s.at - t);
    t = s.at;
    price = s.price;
  }
  if (price === undefined) return null;
  return (area + price * (now - t)) / windowMs;
}

/**
 * The longest stretch over the last `windowMs` up to `now` with no new sample: from the sample holding at the window's
 * start to the next, between samples, and from the last one to `now`. A TWAP holds each price across its gap, so a long
 * one averages a stale price. Null when no sample holds at the window's start.
 */
export function largestGap(samples: readonly Sample[], now: number, windowMs: number): number | null {
  const start = now - windowMs;
  const clean = cleanSamples(samples, now);
  const from = clean.findLastIndex(s => s.at <= start);
  if (from < 0) return null;
  let gap = 0;
  for (let i = from; i < clean.length; i++) gap = Math.max(gap, (clean[i + 1]?.at ?? now) - clean[i]!.at);
  return gap;
}

/**
 * Exponential moving average with time constant `tauMs`, weighted by the time between samples:
 * `ema += (1 − e^(−dt / tau)) × (price − ema)`, starting from the oldest sample. Null for an empty history.
 */
export function ema(samples: readonly Sample[], now: number, tauMs: number): number | null {
  if (!(Number.isFinite(tauMs) && tauMs > 0)) return null;
  const clean = cleanSamples(samples, now);
  if (clean.length === 0) return null;
  let value = clean[0]!.price;
  for (let i = 1; i < clean.length; i++) {
    const dt = clean[i]!.at - clean[i - 1]!.at;
    value += (1 - Math.exp(-dt / tauMs)) * (clean[i]!.price - value);
  }
  return value;
}

/** How far back the usable history reaches from `now`, in milliseconds (0 when empty). */
export function historySpan(samples: readonly Sample[], now: number): number {
  const clean = cleanSamples(samples, now);
  return clean.length === 0 ? 0 : now - clean[0]!.at;
}
