// Forward risk projection (#220): the book carried forward over a horizon, many times, on hourly returns drawn from its
// own recent history, for the stabilization agent's early warning. Pure and deterministic: the only randomness is the
// seeded generator the replay uses, so the same inputs give the same projection. Fails closed: a book, terms, history or
// parameters that can't be read give the most conservative projection (everything lost, no runway, a certain breach) with
// the reason, never an exception and never a quiet pass.
//
// Each path draws hourly log returns with replacement from the lookback window, the same hour for every volatile asset,
// so assets that moved together keep moving together. Each asset's returns are prepared first:
// - centred on their mean, and a falling mean added back while a rising one isn't: two weeks' average is mostly noise, so
//   a rally isn't carried forward as if it would last, while a slide is, which is the warning this exists for;
// - scaled up by how far the last day's volatility (an exponentially weighted average, `volHalfLifeHours`) is above the
//   fortnight's, never down: a crash in its first hours would otherwise be a few draws among 336 calm ones. This is the
//   filtered historical simulation risk desks use, kept one-sided so a quiet day never lowers the projected risk.
// Stables hold their value here (a depeg is a scenario, not a path) and pay the plan's spend each day. Measured over the paths:
// - projected drawdown: the fall from the running high of the book's market value (spend left out), at `confidencePct`;
// - expected shortfall: the mean loss at the horizon over the worst `100 − confidencePct` percent of paths;
// - breach probability: the share of paths in which, on some day, the stables left after spend plus every volatile asset
//   sold (less `liquidationHaircutPct`) would no longer cover the cash floor;
// - runway: months of plan spend the stables fund now, and months until they reach the floor.

import { seededRandom } from "./replay.ts";
import { bookProblems, MONTH_DAYS, termsProblems, type Book, type SpendTerms } from "./scenarios.ts";
import { cleanSamples, type Sample } from "./smoothing.ts";
import { isNum, isPositive, isPositiveInt, report } from "./validate.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;

export const PROJECTION_DEFAULTS = {
  /**
   * A week: long enough for a slide or a venue outage to play out, short enough that an ordinary month of NEAR's
   * volatility doesn't read as a tail event. Runway, which moves slowly, is measured in months regardless.
   */
  horizonDays: 7,
  paths: 500,
  /** Hourly history drawn on: two weeks, so a change in the market shows within days. */
  lookbackDays: 14,
  confidencePct: 95,
  /** Fixed, so two projections an hour apart differ only by what changed, not by the draw. */
  seed: 220,
  /** Selling every volatile asset at once costs this much of its value. */
  liquidationHaircutPct: 2,
  /** The half-life of the recent volatility the draws are scaled to: a day. */
  volHalfLifeHours: 24,
  /**
   * No two neighbouring samples further apart than this: six hours, as `parseHistory` allows. A return across a gap is
   * drawn as one hour's, which overstates the risk and never understates it; a longer gap makes the projection unusable.
   */
  maxGapMs: 6 * HOUR,
  /** The newest sample no older than this: the projection starts from the price now, not from hours ago. */
  maxAgeMs: 2 * HOUR,
} as const;
export type ProjectionParams = {
  horizonDays: number; paths: number; lookbackDays: number; confidencePct: number; seed: number; liquidationHaircutPct: number; volHalfLifeHours: number; maxGapMs: number; maxAgeMs: number;
};

export type Projection = {
  /** False when the inputs couldn't be read: the metrics are then the most conservative, and `reasons` says why. */
  usable: boolean;
  reasons: string[];
  projectedDrawdownPct: number;
  expectedShortfallPct: number;
  breachProbabilityPct: number;
  runwayMonths: number;
  monthsToFloor: number;
  /** The volatile assets' share of the book now, which de-risking scales down. */
  volatileSharePct: number;
};

/** The most conservative projection: everything at risk, no runway, a certain breach. */
export const CONSERVATIVE_PROJECTION: Omit<Projection, "reasons" | "usable"> = {
  projectedDrawdownPct: 100, expectedShortfallPct: 100, breachProbabilityPct: 100, runwayMonths: 0, monthsToFloor: 0, volatileSharePct: 100,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** What is wrong with the parameters, if anything. */
export function projectionParamsProblems(p: unknown): string[] {
  if (!isRecord(p)) return ["the projection parameters must be an object"];
  const r = report();
  r.need(isPositiveInt(p.horizonDays) && (p.horizonDays as number) <= 366, "horizonDays must be a whole number from 1 to 366");
  r.need(isPositiveInt(p.paths) && (p.paths as number) <= 10_000, "paths must be a whole number from 1 to 10000");
  r.need(isPositiveInt(p.lookbackDays) && (p.lookbackDays as number) <= 366, "lookbackDays must be a whole number from 1 to 366");
  r.need(isNum(p.confidencePct) && p.confidencePct >= 50 && p.confidencePct < 100, "confidencePct must be at least 50 and under 100");
  r.need(Number.isInteger(p.seed) && (p.seed as number) >= 0 && (p.seed as number) < 2 ** 32, "seed must be an integer from 0 to 2^32 − 1");
  r.need(isNum(p.liquidationHaircutPct) && p.liquidationHaircutPct >= 0 && p.liquidationHaircutPct < 100, "liquidationHaircutPct must be 0 or more and under 100");
  r.need(isPositive(p.volHalfLifeHours) && (p.volHalfLifeHours as number) <= 24 * 366, "volHalfLifeHours must be above zero and at most a year");
  r.need(isPositive(p.maxGapMs), "maxGapMs must be above zero");
  r.need(isPositive(p.maxAgeMs), "maxAgeMs must be above zero");
  return r.problems;
}

/** Hourly log returns over the lookback, oldest first, or the reason they can't be had. */
function returnsOf(asset: string, history: readonly Sample[] | undefined, at: number, p: ProjectionParams): number[] | string {
  if (!Array.isArray(history)) return `${asset}: no price history`;
  const from = at - p.lookbackDays * DAY;
  const clean = cleanSamples(history, at).filter(s => s.at >= from - p.maxGapMs);
  const first = clean[0], last = clean[clean.length - 1];
  if (!first || !last || clean.length < 2) return `${asset}: no price history in the last ${p.lookbackDays} days`;
  if (first.at > from + p.maxGapMs) return `${asset}: the history covers less than ${p.lookbackDays} days`;
  if (at - last.at > p.maxAgeMs) return `${asset}: the newest price is ${Math.round((at - last.at) / 60_000)} minutes old`;
  const out: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    if (clean[i]!.at - clean[i - 1]!.at > p.maxGapMs) return `${asset}: a gap in its history is over ${p.maxGapMs / 60_000} minutes`;
    out.push(Math.log(clean[i]!.price / clean[i - 1]!.price));
  }
  return out;
}

/**
 * One asset's returns as the paths draw them: centred, scaled up to the recent volatility when it is higher, with a
 * falling mean added back (see the top of this file).
 */
function prepared(r: readonly number[], halfLifeHours: number): number[] {
  const n = r.length, mean = r.reduce((sum, x) => sum + x, 0) / n;
  const centred = r.map(x => x - mean);
  const variance = centred.reduce((sum, x) => sum + x * x, 0) / n;
  const decay = Math.pow(0.5, 1 / halfLifeHours);
  let weighted = 0, weights = 0;
  for (let i = 0; i < n; i++) { const w = Math.pow(decay, n - 1 - i); weighted += w * centred[i]! ** 2; weights += w; }
  const scale = variance > 0 ? Math.max(1, Math.sqrt(weighted / weights / variance)) : 1;
  return centred.map(x => x * scale + Math.min(0, mean));
}

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * The projection for a book at `at`. `history` holds each volatile asset's hourly prices, by asset; a volatile asset
 * worth nothing needs none. Returns `usable: false` with the conservative metrics when anything can't be read.
 */
export function project(book: Book, terms: SpendTerms, history: Readonly<Record<string, readonly Sample[]>>, at: number,
  params: ProjectionParams = PROJECTION_DEFAULTS): Projection {
  const conservative = (reasons: string[]): Projection => ({ usable: false, reasons, ...CONSERVATIVE_PROJECTION });
  const problems = [...bookProblems(book), ...termsProblems(terms), ...projectionParamsProblems(params)];
  if (!isNum(at)) problems.push("the time of the projection is unusable");
  if (!isRecord(history)) problems.push("the price history must be an object by asset");
  if (problems.length > 0) return conservative(problems);

  const volatile = book.filter(h => h.class === "volatile" && h.usd > 0);
  const returns: number[][] = [];
  for (const h of volatile) {
    const r = returnsOf(h.asset, Object.hasOwn(history, h.asset) ? history[h.asset] : undefined, at, params);
    if (typeof r === "string") problems.push(r); else returns.push(r);
  }
  if (problems.length > 0) return conservative(problems);

  const stables = book.filter(h => h.class === "stable").reduce((sum, h) => sum + h.usd, 0);
  const start = volatile.reduce((sum, h) => sum + h.usd, 0);
  const total = start + stables, spend = terms.monthlySpendUsd, floor = spend * terms.operatingCashMonths;
  const runwayMonths = stables / spend, monthsToFloor = (stables - floor) / spend;
  const base = { usable: true, reasons: [], runwayMonths: round(runwayMonths), monthsToFloor: round(monthsToFloor), volatileSharePct: round(start / total * 100) };
  // Nothing volatile: nothing moves, and the floor holds as long as the stables do over the horizon.
  const n = Math.min(...returns.map(r => r.length));
  const steps = params.horizonDays * 24, daily = spend / MONTH_DAYS, keep = 1 - params.liquidationHaircutPct / 100;
  if (volatile.length === 0) {
    const breach = stables - daily * params.horizonDays < floor;
    return { ...base, projectedDrawdownPct: 0, expectedShortfallPct: 0, breachProbabilityPct: breach ? 100 : 0 };
  }
  // The same hours for every asset: each asset's last `n` returns, aligned at the newest.
  const aligned = returns.map(r => prepared(r.slice(r.length - n), params.volHalfLifeHours));
  const random = seededRandom(params.seed);
  const drawdowns: number[] = [], losses: number[] = [];
  let breaches = 0;
  const values = new Float64Array(volatile.length);
  for (let path = 0; path < params.paths; path++) {
    volatile.forEach((h, i) => { values[i] = h.usd; });
    let peak = total, worst = 0, breached = false, market = total;
    for (let step = 1; step <= steps; step++) {
      const j = Math.floor(random() * n);
      let sum = 0;
      for (let i = 0; i < values.length; i++) { values[i] = values[i]! * Math.exp(aligned[i]![j]!); sum += values[i]!; }
      market = sum + stables;
      if (market > peak) peak = market; else worst = Math.max(worst, (peak - market) / peak);
      if (!breached && step % 24 === 0 && stables - daily * (step / 24) + sum * keep < floor) breached = true;
    }
    drawdowns.push(worst * 100);
    losses.push((total - market) / total * 100);
    if (breached) breaches++;
  }
  drawdowns.sort((a, b) => a - b);
  losses.sort((a, b) => b - a);
  const tail = Math.max(1, Math.ceil((1 - params.confidencePct / 100) * params.paths));
  const shortfall = losses.slice(0, tail).reduce((sum, l) => sum + l, 0) / tail;
  return {
    ...base,
    projectedDrawdownPct: round(drawdowns[Math.max(0, Math.ceil(params.confidencePct / 100 * params.paths) - 1)]!),
    expectedShortfallPct: round(Math.max(0, shortfall)),
    breachProbabilityPct: round(breaches / params.paths * 100),
  };
}
