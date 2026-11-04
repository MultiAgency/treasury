// Edge-case detectors, market moves (A6.1): fast rise, fast drop, crash, parabolic move and sideways chop, over the
// oracle's sample history. Pure: the history and the clock are passed in. Each detection names an escalation level;
// the highest decides. All thresholds, windows and levels are named defaults, awaiting H6/H9/H11 (the plan lists
// the cases but gives no numbers). A history too short to judge is itself a conservative detection, never silence.

import type { Level } from "./levels.ts";
import { cleanSamples, historySpan, type Sample } from "./smoothing.ts";
import { isNonNegative, isPositive, isPositiveInt, report } from "./validate.ts";

export const DETECTOR_DEFAULTS = {
  hourMs: 3_600_000,
  dayMs: 86_400_000,
  /** Move over the last hour that raises L1 and L2. */
  fastMovePct: { l1: 10, l2: 20 },
  /** A fall over the last day at or beyond this is a crash (L3). */
  crashPct: 30,
  /** A rise over the last day at or beyond this is parabolic (L2). */
  parabolicPct: 40,
  /** Many direction reversals with almost no net move over the last day is chop (L1). */
  chop: { minReversals: 6, maxNetMovePct: 2 },
  /** Less history than this can't be judged. */
  minHistoryMs: 86_400_000,
} as const;

export type DetectorConfig = {
  hourMs: number; dayMs: number;
  fastMovePct: { l1: number; l2: number };
  crashPct: number; parabolicPct: number;
  chop: { minReversals: number; maxNetMovePct: number };
  minHistoryMs: number;
};

export type DetectorName = "config" | "history" | "fast-rise" | "fast-drop" | "crash" | "parabolic" | "sideways-chop";
export type Detection = { detector: DetectorName; level: Level; reason: string };

/** What is wrong with the thresholds, if anything. */
export function detectorProblems(c: DetectorConfig): string[] {
  const r = report();
  r.need(isPositive(c.hourMs) && isPositive(c.dayMs) && c.dayMs >= c.hourMs, "windows must be above zero, the day at least an hour");
  r.need(isPositive(c.fastMovePct.l1) && isPositive(c.fastMovePct.l2) && c.fastMovePct.l2 >= c.fastMovePct.l1, "fast-move thresholds must be above zero and rising");
  r.need(isPositive(c.crashPct) && isPositive(c.parabolicPct), "crash and parabolic thresholds must be above zero");
  r.need(isPositiveInt(c.chop.minReversals) && isNonNegative(c.chop.maxNetMovePct), "chop needs a whole number of reversals and a net move of zero or more");
  r.need(isNonNegative(c.minHistoryMs), "minHistoryMs must be zero or more");
  return r.problems;
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
 * so a move exactly at a threshold counts.
 */
export function detectMarketMoves(samples: readonly Sample[], now: number, cfg: DetectorConfig = DETECTOR_DEFAULTS): Detection[] {
  const unusable = detectorProblems(cfg);
  if (unusable.length > 0) return [{ detector: "config", level: 1, reason: `invalid detector configuration: ${unusable.join("; ")}` }];
  const clean = cleanSamples(samples, now);
  const last = clean[clean.length - 1];
  if (last === undefined || clean.length < 2 || historySpan(clean, now) < cfg.minHistoryMs)
    return [{ detector: "history", level: 1, reason: "not enough price history to judge the market" }];

  const found: Detection[] = [];
  const then1h = priceAt(clean, now - cfg.hourMs), then24h = priceAt(clean, now - cfg.dayMs);
  const now_ = last.price;
  const moved = (from: number | null, pct: number, up: boolean) =>
    from !== null && (up ? (now_ - from) * 100 >= pct * from : (from - now_) * 100 >= pct * from);

  if (moved(then1h, cfg.fastMovePct.l2, true)) found.push({ detector: "fast-rise", level: 2, reason: `up ${cfg.fastMovePct.l2}% or more in an hour` });
  else if (moved(then1h, cfg.fastMovePct.l1, true)) found.push({ detector: "fast-rise", level: 1, reason: `up ${cfg.fastMovePct.l1}% or more in an hour` });
  if (moved(then1h, cfg.fastMovePct.l2, false)) found.push({ detector: "fast-drop", level: 2, reason: `down ${cfg.fastMovePct.l2}% or more in an hour` });
  else if (moved(then1h, cfg.fastMovePct.l1, false)) found.push({ detector: "fast-drop", level: 1, reason: `down ${cfg.fastMovePct.l1}% or more in an hour` });
  if (moved(then24h, cfg.crashPct, false)) found.push({ detector: "crash", level: 3, reason: `down ${cfg.crashPct}% or more in a day` });
  if (moved(then24h, cfg.parabolicPct, true)) found.push({ detector: "parabolic", level: 2, reason: `up ${cfg.parabolicPct}% or more in a day` });

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
