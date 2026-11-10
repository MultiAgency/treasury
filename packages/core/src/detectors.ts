// Edge-case detectors, market moves (A6.1): fast rise, fast drop, crash, parabolic move and sideways chop, over the
// oracle's sample history. Pure: the history and the clock are passed in. Each detection names an escalation level;
// the highest decides. The levels are H11's and the chop rule is H9's (ADR 3); the other thresholds are named defaults
// that ADR 3 keeps as they are. A history too short to judge is itself a conservative detection, never silence.

import type { Level } from "./levels.ts";
import { cleanSamples, historySpan, type Sample } from "./smoothing.ts";
import { guarded, isNonNegative, isPositive, isPositiveInt, report } from "./validate.ts";

export const DETECTOR_DEFAULTS = {
  hourMs: 3_600_000,
  dayMs: 86_400_000,
  /** Move over the last hour that raises L1 and L2. */
  fastMovePct: { l1: 10, l2: 20 },
  /** A fall from a high to a later low within the day, at or beyond this, is a crash (L3), even if the price recovered. */
  crashPct: 30,
  /** A rise from a low to a later high within the day, at or beyond this, is parabolic (L2), even if it fell back. */
  parabolicPct: 40,
  /**
   * Many direction reversals with almost no net move over the last day is chop (L1). Counted per sample, so it assumes
   * hourly samples: 6 reversals and 2% fired in 37% of a year's hours on NEAR, these in 4.7% (H9, ADR 3).
   */
  chop: { minReversals: 14, maxNetMovePct: 1 },
  /** Less history than this can't be judged. */
  minHistoryMs: 86_400_000,
  /** A newest sample older than this leaves the last stretch unseen, so it can't be judged either. */
  maxSampleAgeMs: 15 * 60_000,
} as const;

export type DetectorConfig = {
  hourMs: number; dayMs: number;
  fastMovePct: { l1: number; l2: number };
  crashPct: number; parabolicPct: number;
  chop: { minReversals: number; maxNetMovePct: number };
  minHistoryMs: number;
  maxSampleAgeMs: number;
};

export type DetectorName = "config" | "history" | "fast-rise" | "fast-drop" | "crash" | "parabolic" | "sideways-chop";
export type Detection = { detector: DetectorName; level: Level; reason: string };

/** What is wrong with the thresholds, if anything. */
export function detectorProblems(c: DetectorConfig): string[] {
  return guarded(() => {
  const r = report();
  r.need(isPositive(c.hourMs) && isPositive(c.dayMs) && c.dayMs >= c.hourMs, "windows must be above zero, the day at least an hour");
  // A fall is under 100% (prices stay above zero), so a threshold of 100% or more could never trigger on a drop.
  r.need(isPositive(c.fastMovePct.l1) && isPositive(c.fastMovePct.l2) && c.fastMovePct.l2 >= c.fastMovePct.l1 && c.fastMovePct.l2 < 100,
    "fast-move thresholds must be above zero, rising, and under 100%");
  r.need(isPositive(c.crashPct) && c.crashPct < 100 && isPositive(c.parabolicPct), "crash threshold must be above zero and under 100%, parabolic above zero");
  r.need(isPositiveInt(c.chop.minReversals) && isNonNegative(c.chop.maxNetMovePct), "chop needs a whole number of reversals and a net move of zero or more");
  r.need(isNonNegative(c.minHistoryMs), "minHistoryMs must be zero or more");
  r.need(isPositive(c.maxSampleAgeMs), "maxSampleAgeMs must be above zero");
  return r.problems;
  });
}

/** The price in effect at `t`: the last sample at or before it, or null if there is none. */
function priceAt(clean: readonly Sample[], t: number): number | null {
  let price: number | null = null;
  for (const s of clean) { if (s.at <= t) price = s.price; else break; }
  return price;
}

/** The highest level among detections (0 when there are none). */
export function highestLevel(detections: readonly Detection[]): Level {
  return detections.reduce<Level>((top, d) => (d.level > top ? d.level : top), 0);
}

/**
 * Market-move detections at `now`. Moves are compared without dividing (change × 100 against percent × starting price),
 * so a move exactly at a threshold counts. Crash and parabolic look at the whole day, not only where it ends: a crash is
 * a fall from a high to a later low within the day, a parabolic move a rise from a low to a later high, so 100 → 140 → 98
 * is a crash (30% off the high) and stays one after the price recovers.
 */
export function detectMarketMoves(samples: readonly Sample[], now: number, cfg: DetectorConfig = DETECTOR_DEFAULTS): Detection[] {
  const unusable = detectorProblems(cfg);
  if (unusable.length > 0) return [{ detector: "config", level: 1, reason: `invalid detector configuration: ${unusable.join("; ")}` }];
  const clean = cleanSamples(samples, now);
  const last = clean[clean.length - 1];
  if (last === undefined || clean.length < 2 || historySpan(clean, now) < cfg.minHistoryMs)
    return [{ detector: "history", level: 1, reason: "not enough price history to judge the market" }];
  if (now - last.at > cfg.maxSampleAgeMs)
    return [{ detector: "history", level: 1, reason: `the newest price is ${now - last.at} ms old: the market since then can't be judged` }];

  const found: Detection[] = [];
  const then1h = priceAt(clean, now - cfg.hourMs), then24h = priceAt(clean, now - cfg.dayMs);
  const now_ = last.price;
  const moved = (from: number | null, pct: number, up: boolean) =>
    from !== null && (up ? (now_ - from) * 100 >= pct * from : (from - now_) * 100 >= pct * from);

  if (moved(then1h, cfg.fastMovePct.l2, true)) found.push({ detector: "fast-rise", level: 2, reason: `up ${cfg.fastMovePct.l2}% or more in an hour` });
  else if (moved(then1h, cfg.fastMovePct.l1, true)) found.push({ detector: "fast-rise", level: 1, reason: `up ${cfg.fastMovePct.l1}% or more in an hour` });
  if (moved(then1h, cfg.fastMovePct.l2, false)) found.push({ detector: "fast-drop", level: 2, reason: `down ${cfg.fastMovePct.l2}% or more in an hour` });
  else if (moved(then1h, cfg.fastMovePct.l1, false)) found.push({ detector: "fast-drop", level: 1, reason: `down ${cfg.fastMovePct.l1}% or more in an hour` });
  // The day's prices in order: the one in effect at its start (if any), then each sample within it. Each is compared with
  // the high and low seen before it, so only a fall after a high, or a rise after a low, counts, wherever the day ends.
  const dayPrices = [...(then24h === null ? [] : [then24h]), ...clean.filter(s => s.at > now - cfg.dayMs).map(s => s.price)];
  let high = -Infinity, low = Infinity, crash = false, parabolic = false;
  for (const p of dayPrices) {
    high = Math.max(high, p); low = Math.min(low, p);
    crash ||= (high - p) * 100 >= cfg.crashPct * high;
    parabolic ||= (p - low) * 100 >= cfg.parabolicPct * low;
  }
  if (crash) found.push({ detector: "crash", level: 3, reason: `down ${cfg.crashPct}% or more from a high within a day` });
  if (parabolic) found.push({ detector: "parabolic", level: 2, reason: `up ${cfg.parabolicPct}% or more from a low within a day` });

  if (then24h !== null) {
    const day = clean.filter(s => s.at > now - cfg.dayMs);
    let reversals = 0, previous = 0, before = then24h;
    for (const s of day) {
      const sign = Math.sign(s.price - before);
      if (sign !== 0) { if (previous !== 0 && sign !== previous) reversals++; previous = sign; }
      before = s.price;
    }
    const net = Math.abs(now_ - then24h) * 100;
    if (reversals >= cfg.chop.minReversals && net <= cfg.chop.maxNetMovePct * then24h)
      found.push({ detector: "sideways-chop", level: 1, reason: `${reversals} reversals in a day with almost no net move` });
  }
  return found;
}

/**
 * Market moves per asset (#221): each sleeve's asset judged on its own history, so a crash in ETH holds the ETH sleeve
 * and raises the book's level, and a wNEAR sleeve whose history is too short is judged too short on its own.
 */
export function detectBookMoves(histories: Readonly<Record<string, readonly Sample[]>>, now: number, cfg: DetectorConfig = DETECTOR_DEFAULTS): Record<string, Detection[]> {
  return Object.fromEntries(Object.entries(histories).map(([asset, samples]) => [asset, detectMarketMoves(samples, now, cfg)]));
}
