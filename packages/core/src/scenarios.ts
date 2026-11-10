// Stress scenarios (#220): the book re-run under tail events, for the stabilization agent. Pure; fails closed: a book,
// spend terms or parameters that can't be read give the most conservative result with the reason, never an exception
// and never a pass. The book is a list of holdings (asset, class, value, venue), not two fixed sleeves, so each new
// volatile asset, stablecoin and venue (#221) becomes its own scenarios here without any change to this file.

import { isNum, isPositive, report } from "./validate.ts";
import type { AssetClass } from "./assets.ts";

/** Volatile assets move with the market; stables are the reserve and the operating cash, worth about $1 each. */
/** The risk book holds volatile and stable assets only: the registry's classes (`assets.ts`) less `rwa`. */
export type RiskAssetClass = Exclude<AssetClass, "rwa">;
/**
 * One holding of the book: its asset (on the server, the platform's asset ID, so a de-risk sell can be built from it), its
 * class, its USD value now, the venue it is held and settles at, and optionally the symbol a person reads (`wNEAR`).
 */
export type BookHolding = { asset: string; class: RiskAssetClass; usd: number; venue: string; symbol?: string };
export type Book = readonly BookHolding[];
/** The mandate's spend terms: the cash floor is `monthlySpendUsd × operatingCashMonths` (`compileMandate`). */
export type SpendTerms = { monthlySpendUsd: number; operatingCashMonths: number };

/** A month, for spend and runway: 30 days. */
export const MONTH_DAYS = 30;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** What is wrong with a book, if anything: every holding readable, each asset once, at least one stable, a value above zero. */
export function bookProblems(book: unknown): string[] {
  const r = report();
  if (!Array.isArray(book) || book.length === 0) return ["the book must list at least one holding"];
  const seen = new Set<string>();
  let total = 0, stables = 0;
  for (const [i, h] of book.entries()) {
    if (!isRecord(h)) { r.need(false, `holding ${i} is not an object`); continue; }
    const ok = typeof h.asset === "string" && h.asset.length > 0 && (h.class === "volatile" || h.class === "stable")
      && isNum(h.usd) && h.usd >= 0 && typeof h.venue === "string" && h.venue.length > 0
      && (h.symbol === undefined || (typeof h.symbol === "string" && h.symbol.length > 0));
    if (!ok) { r.need(false, `holding ${i} needs an asset, a class (volatile or stable), a USD value of zero or more, a venue, and a symbol if it has one`); continue; }
    r.need(!seen.has(h.asset as string), `${h.asset as string} is listed twice`);
    seen.add(h.asset as string);
    total += h.usd as number;
    if (h.class === "stable") stables++;
  }
  r.need(stables > 0, "the book holds no stable asset: spend has nothing to draw on");
  r.need(total > 0, "the book is worth nothing");
  return r.problems;
}

/** What is wrong with the spend terms, if anything. A zero spend or zero months would switch the floor off, as in `exposureProblems`. */
export function termsProblems(t: unknown): string[] {
  if (!isRecord(t)) return ["the spend terms must be an object"];
  const r = report();
  r.need(isPositive(t.monthlySpendUsd), "monthlySpendUsd must be above zero");
  r.need(isPositive(t.operatingCashMonths), "operatingCashMonths must be above zero");
  return r.problems;
}

/**
 * One tail event, applied at once: `price` multiplies an asset's value by `factor` (a fall of 30% is 0.7; a stable at
 * $0.95 is 0.95 of its value now, which is about $1); `venue-down` makes a venue's holdings unreachable for `days`; with
 * `sources-stale` no price can be trusted, so nothing trades for `days`; `spend` multiplies the plan's spend.
 */
export type Shock =
  | { kind: "price"; asset: string; factor: number }
  | { kind: "venue-down"; venue: string; days: number }
  | { kind: "sources-stale"; days: number }
  | { kind: "spend"; factor: number };
export type Scenario = { id: string; label: string; shocks: readonly Shock[] };

/** The issue's scenarios (#220), applied to every asset and venue the book holds. */
export const SCENARIO_DEFAULTS = {
  /** Each volatile asset falls this many percent in a day. */
  volatileDropsPct: [30, 50, 80],
  /** Each stable trades at these prices. */
  stablePrices: [0.95, 0.9],
  /** Each venue is unreachable this many days: the NEAR Intents account for 24 hours and for 7 days. */
  venueOutageDays: [1, 7],
  /** Every price source stale this long: the oracle freezes, so nothing trades. */
  staleDays: 1,
  /** Spend runs at this multiple of the plan. */
  spendFactor: 2,
} as const;
export type ScenarioParams = { volatileDropsPct: readonly number[]; stablePrices: readonly number[]; venueOutageDays: readonly number[]; staleDays: number; spendFactor: number };

/** What is wrong with the parameters, if anything. */
export function scenarioParamsProblems(p: unknown): string[] {
  if (!isRecord(p)) return ["the scenario parameters must be an object"];
  const r = report();
  const list = (x: unknown, ok: (n: unknown) => boolean) => Array.isArray(x) && x.every(ok);
  r.need(list(p.volatileDropsPct, n => isNum(n) && n > 0 && n < 100), "volatileDropsPct must be percents above 0 and under 100");
  r.need(list(p.stablePrices, n => isNum(n) && n > 0 && n < 1), "stablePrices must be above 0 and under 1");
  r.need(list(p.venueOutageDays, isPositive), "venueOutageDays must be above zero");
  r.need(isPositive(p.staleDays), "staleDays must be above zero");
  r.need(isNum(p.spendFactor) && p.spendFactor > 1, "spendFactor must be above 1");
  return r.problems;
}

/**
 * The scenarios for a book: each volatile asset's falls, each stable's depegs, each venue's outages, every source stale,
 * and spend over plan. Nothing here names an asset or a venue: they come from the book. A book or parameters that can't
 * be read give no scenarios (`stressAll` reports why).
 */
export function scenariosFor(book: Book, params: ScenarioParams = SCENARIO_DEFAULTS): Scenario[] {
  if (bookProblems(book).length > 0 || scenarioParamsProblems(params).length > 0) return [];
  const out: Scenario[] = [];
  for (const h of book) {
    const name = h.symbol ?? h.asset;
    if (h.class === "volatile") for (const pct of params.volatileDropsPct)
      out.push({ id: `drop:${h.asset}:${pct}`, label: `${name} falls ${pct}% in a day`, shocks: [{ kind: "price", asset: h.asset, factor: 1 - pct / 100 }] });
    else for (const price of params.stablePrices)
      out.push({ id: `depeg:${h.asset}:${price}`, label: `${name} trades at $${price}`, shocks: [{ kind: "price", asset: h.asset, factor: price }] });
  }
  for (const venue of [...new Set(book.map(h => h.venue))]) for (const days of params.venueOutageDays)
    out.push({ id: `venue:${venue}:${days}d`, label: `${venue} unavailable for ${days === 1 ? "24 hours" : `${days} days`}`, shocks: [{ kind: "venue-down", venue, days }] });
  out.push({ id: "sources-stale", label: `Every price source stale for ${params.staleDays === 1 ? "a day" : `${params.staleDays} days`}`, shocks: [{ kind: "sources-stale", days: params.staleDays }] });
  out.push({ id: `spend:${params.spendFactor}x`, label: `Spend at ${params.spendFactor}× plan`, shocks: [{ kind: "spend", factor: params.spendFactor }] });
  return out;
}

/** What a scenario leaves: the book's value and fall, the stables reachable after it, and whether the floor still holds. */
export type StressResult = {
  id: string; label: string;
  /** The book's value after the shock, and its fall from now. */
  valueUsd: number; lossUsd: number; drawdownPct: number;
  /** Stables after the shock and after paying the spend that fell due during it. */
  stableUsd: number;
  /** Months those stables fund at the scenario's spend rate. */
  runwayMonths: number;
  /** The floor at the scenario's spend rate (`operatingCashMonths` of it), and whether the stables fall under it. */
  floorUsd: number; floorBreached: boolean;
  /** Spend that falls due while the venues holding the stables are down and the stables elsewhere can't pay it. */
  unfundedUsd: number;
  /** Whether the agent can trade at all during it: prices fresh, and every volatile asset's venue up. */
  tradable: boolean;
  /** Why the result is the conservative one, when the inputs couldn't be read; empty otherwise. */
  reasons: string[];
};

/** Rounds a money or percent value for the record: cents and hundredths are all the report shows. */
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** The most conservative result: everything lost, nothing reachable, the floor breached, and why. */
const failClosed = (id: string, label: string, reasons: string[]): StressResult =>
  ({ id, label, valueUsd: 0, lossUsd: 0, drawdownPct: 100, stableUsd: 0, runwayMonths: 0, floorUsd: 0, floorBreached: true, unfundedUsd: 0, tradable: false, reasons });

function shockProblems(s: unknown): string | null {
  if (!isRecord(s)) return "a shock must be an object";
  switch (s.kind) {
    case "price": return typeof s.asset === "string" && isPositive(s.factor) ? null : "a price shock needs an asset and a factor above zero";
    case "venue-down": return typeof s.venue === "string" && isPositive(s.days) ? null : "a venue outage needs a venue and days above zero";
    case "sources-stale": return isPositive(s.days) ? null : "stale sources need days above zero";
    case "spend": return isPositive(s.factor) ? null : "a spend shock needs a factor above zero";
    default: return "unknown shock";
  }
}

/** One scenario over the book. Anything unreadable gives the conservative result with its reasons. */
export function stressRun(book: Book, terms: SpendTerms, scenario: Scenario): StressResult {
  const id = typeof scenario?.id === "string" ? scenario.id : "unknown", label = typeof scenario?.label === "string" ? scenario.label : id;
  const problems = [...bookProblems(book), ...termsProblems(terms)];
  if (!Array.isArray(scenario?.shocks)) problems.push("the scenario lists no shocks");
  else for (const s of scenario.shocks) { const p = shockProblems(s); if (p) problems.push(p); }
  if (problems.length > 0) return failClosed(id, label, problems);

  const before = book.reduce((sum, h) => sum + h.usd, 0);
  const factor = new Map<string, number>(), down = new Map<string, number>();
  let spendFactor = 1, staleDays = 0;
  for (const s of scenario.shocks) {
    if (s.kind === "price") factor.set(s.asset, (factor.get(s.asset) ?? 1) * s.factor);
    else if (s.kind === "venue-down") down.set(s.venue, Math.max(down.get(s.venue) ?? 0, s.days));
    else if (s.kind === "sources-stale") staleDays = Math.max(staleDays, s.days);
    else spendFactor *= s.factor;
  }
  const after = book.map(h => ({ ...h, usd: h.usd * (factor.get(h.asset) ?? 1) }));
  const valueUsd = after.reduce((sum, h) => sum + h.usd, 0);
  const monthly = terms.monthlySpendUsd * spendFactor;
  // Spend falls due through the longest outage; the stables on venues still up pay what they can, and the rest waits.
  const outageDays = Math.max(0, ...down.values());
  const due = monthly * outageDays / MONTH_DAYS;
  const reachable = after.filter(h => h.class === "stable" && !down.has(h.venue)).reduce((sum, h) => sum + h.usd, 0);
  const stables = after.filter(h => h.class === "stable").reduce((sum, h) => sum + h.usd, 0);
  const stableUsd = Math.max(0, stables - due);
  const floorUsd = monthly * terms.operatingCashMonths;
  const tradable = staleDays === 0 && !after.some(h => h.class === "volatile" && down.has(h.venue));
  return {
    id, label, valueUsd: round(valueUsd), lossUsd: round(before - valueUsd), drawdownPct: round((before - valueUsd) / before * 100),
    stableUsd: round(stableUsd), runwayMonths: round(stableUsd / monthly), floorUsd: round(floorUsd), floorBreached: stableUsd < floorUsd,
    unfundedUsd: round(Math.max(0, due - reachable)), tradable, reasons: [],
  };
}

/**
 * Every scenario for the book, most severe first: a breached floor, then the largest fall, then the most spend left
 * unfunded, then the shortest runway. An unreadable book or parameters give one conservative result naming why.
 */
export function stressAll(book: Book, terms: SpendTerms, params: ScenarioParams = SCENARIO_DEFAULTS): StressResult[] {
  const problems = [...bookProblems(book), ...termsProblems(terms), ...scenarioParamsProblems(params)];
  if (problems.length > 0) return [failClosed("unreadable", "The book can't be stressed", problems)];
  return scenariosFor(book, params).map(s => stressRun(book, terms, s)).sort((a, b) =>
    Number(b.floorBreached) - Number(a.floorBreached) || b.drawdownPct - a.drawdownPct || b.unfundedUsd - a.unfundedUsd
    || a.runwayMonths - b.runwayMonths || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
