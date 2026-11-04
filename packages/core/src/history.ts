// Price-history loader for the backtest (A8.2). Pure: text in, samples out. Fails closed: one unusable row, a gap too
// long, or a span too short makes the whole load fail with the reasons, never a quietly patched series. Until H5 names
// the real sources (and their data), `syntheticSeries` gives a documented, seeded stand-in; see HISTORY.md.

import { seededRandom } from "./replay.ts";
import type { Sample } from "./smoothing.ts";
import { isPositive, report } from "./validate.ts";

export const HISTORY_DEFAULTS = {
  /** The history must cover at least this long (12 months). */
  minSpanMs: 365 * 86_400_000,
  /** No two neighbouring samples may be further apart than this. */
  maxGapMs: 6 * 3_600_000,
} as const;
export type HistoryLimits = { minSpanMs: number; maxGapMs: number };

export type HistoryLoad =
  | { ok: true; samples: Sample[]; spanMs: number; maxGapMs: number }
  | { ok: false; problems: string[] };

/**
 * Reads `timestamp,price` lines. The timestamp is Unix ms or an ISO date; a header line, blank lines and `#` comments are
 * skipped. Rows may come in any order; two rows at one instant with different prices fail the load (ambiguous).
 */
export function parseHistory(text: string, limits: HistoryLimits = HISTORY_DEFAULTS): HistoryLoad {
  const r = report();
  r.need(isPositive(limits.minSpanMs) && isPositive(limits.maxGapMs), "history limits must be above zero");
  const byTime = new Map<number, number>();
  const lines = text.split(/\r?\n/);
  let firstRow = true;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const isFirst = firstRow;
    firstRow = false;
    const [stamp, value, ...extra] = line.split(",").map(x => x.trim());
    if (isFirst && Number.isNaN(Number(stamp)) && Number.isNaN(Date.parse(stamp ?? ""))) return; // header
    const at = /^-?\d+(\.\d+)?$/.test(stamp ?? "") ? Number(stamp) : Date.parse(stamp ?? "");
    const price = value !== undefined && /^[0-9]*\.?[0-9]+(e[+-]?\d+)?$/i.test(value) ? Number(value) : Number.NaN;
    if (extra.length > 0 || !Number.isFinite(at) || !Number.isFinite(price) || price <= 0) { r.need(false, `line ${i + 1}: unusable row "${line.slice(0, 60)}"`); return; }
    const seen = byTime.get(at);
    if (seen !== undefined && seen !== price) r.need(false, `line ${i + 1}: two different prices at ${at}`);
    byTime.set(at, price);
  });
  const samples = [...byTime].map(([at, price]) => ({ at, price })).sort((a, b) => a.at - b.at);
  if (samples.length < 2) r.need(false, "fewer than two usable rows");
  let widest = 0;
  for (let i = 1; i < samples.length; i++) widest = Math.max(widest, samples[i]!.at - samples[i - 1]!.at);
  const spanMs = samples.length < 2 ? 0 : samples[samples.length - 1]!.at - samples[0]!.at;
  if (samples.length >= 2) {
    r.need(spanMs >= limits.minSpanMs, `history covers ${spanMs} ms, ${limits.minSpanMs} ms needed`);
    r.need(widest <= limits.maxGapMs, `a gap of ${widest} ms is over the ${limits.maxGapMs} ms limit`);
  }
  return r.problems.length > 0 ? { ok: false, problems: r.problems.slice(0, 20) } : { ok: true, samples, spanMs, maxGapMs: widest };
}

export type SyntheticSpec = {
  startAt: number;
  startPrice: number;
  /** Number of samples and the step between them. */
  count: number;
  stepMs: number;
  /** Largest move per step, in percent (uniform in ± this). */
  stepVolPct: number;
  /** Per-step drift, in percent. */
  driftPct: number;
  seed: number;
};

/** A documented stand-in series: a seeded random walk, positive by construction. The same spec gives the same series. */
export function syntheticSeries(s: SyntheticSpec): Sample[] {
  const ok = [s.startAt, s.seed].every(Number.isFinite) && isPositive(s.startPrice) && isPositive(s.stepMs) && isPositive(s.stepVolPct)
    && Number.isFinite(s.driftPct) && Number.isInteger(s.count) && s.count > 0 && s.stepVolPct < 100;
  if (!ok) return [];
  const random = seededRandom(s.seed);
  const out: Sample[] = [];
  let price = s.startPrice;
  for (let i = 0; i < s.count; i++) {
    out.push({ at: s.startAt + i * s.stepMs, price });
    price = Math.max(price * (1 + s.driftPct / 100 + (random() * 2 - 1) * (s.stepVolPct / 100)), s.startPrice * 1e-6);
  }
  return out;
}

/**
 * Pre-history that ends one step before `first`, so the EMA has its warm-up when the replay starts: a seeded walk run
 * backwards from `first.price` over `spanMs`, with the same volatility. Documented in HISTORY.md for the demo.
 */
export function warmupHistory(first: Sample, spanMs: number, stepMs: number, stepVolPct: number, seed: number): Sample[] {
  if (!(isPositive(first.price) && Number.isFinite(first.at) && isPositive(spanMs) && isPositive(stepMs) && isPositive(stepVolPct) && stepVolPct < 100)) return [];
  const random = seededRandom(seed);
  const out: Sample[] = [];
  let price = first.price;
  for (let at = first.at - stepMs; at >= first.at - spanMs; at -= stepMs) {
    price = Math.max(price / (1 + (random() * 2 - 1) * (stepVolPct / 100)), first.price * 1e-6);
    out.push({ at, price });
  }
  return out.reverse();
}
