// A what-if for the owner (#220): one tail event of their own choosing, run over a recorded book with the same stress
// run the stabilization agent uses. Pure; fails closed: an event that names nothing, a number out of range or a book that
// can't be read gives a refusal with the reasons, never a result that looks like a pass.

import { bookProblems, stressRun, termsProblems, type Book, type Scenario, type Shock, type SpendTerms, type StressResult } from "./scenarios.ts";

/**
 * The event, every part optional but at least one needed. Price falls apply to every volatile holding (or to `asset`
 * alone), a stablecoin price to every stable holding (or `asset` alone), an outage to every venue (or `venue` alone).
 */
export type WhatIf = {
  /** A fall in a day, in percent: above 0 and at most 100. */
  volatileDropPct?: number;
  /** A stablecoin's price in USD: above 0 and at most 1.5. */
  stablePrice?: number;
  /** A venue unreachable this many days: above 0 and at most 90. */
  venueOutageDays?: number;
  /** Spend as a multiple of plan: above 0 and at most 20. */
  spendFactor?: number;
  /** Every price source stale this many days: above 0 and at most 30. */
  staleDays?: number;
  /** Limits the price shock to this one holding, by its asset ID. */
  asset?: string;
  /** Limits the outage to this one venue. */
  venue?: string;
};

export type WhatIfResult =
  | { ok: true; label: string; scenario: Scenario; now: StressResult; after: StressResult }
  | { ok: false; problems: string[] };

const inRange = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n > min && n <= max;

/** What is wrong with the event, if anything. */
export function whatIfProblems(event: unknown): string[] {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return ["the what-if must be an object"];
  const e = event as Record<string, unknown>;
  const problems: string[] = [];
  const check = (key: keyof WhatIf, min: number, max: number, say: string) => { if (e[key] !== undefined && !inRange(e[key], min, max)) problems.push(say); };
  check("volatileDropPct", 0, 100, "volatileDropPct must be above 0 and at most 100");
  check("stablePrice", 0, 1.5, "stablePrice must be above 0 and at most 1.5");
  check("venueOutageDays", 0, 90, "venueOutageDays must be above 0 and at most 90");
  check("spendFactor", 0, 20, "spendFactor must be above 0 and at most 20");
  check("staleDays", 0, 30, "staleDays must be above 0 and at most 30");
  for (const key of ["asset", "venue"] as const) if (e[key] !== undefined && (typeof e[key] !== "string" || (e[key] as string).length === 0)) problems.push(`${key} must be a name`);
  const events = ["volatileDropPct", "stablePrice", "venueOutageDays", "spendFactor", "staleDays"].filter(key => e[key] !== undefined);
  if (events.length === 0) problems.push("name at least one event: a fall, a stablecoin price, an outage, a spend factor or stale prices");
  return problems;
}

/**
 * The event over the book: what the book is worth, how far the stables and the floor hold, and whether the agent could
 * still trade, next to the same book today. A named asset or venue the book doesn't hold is refused, not ignored.
 */
export function whatIf(book: Book, terms: SpendTerms, event: WhatIf): WhatIfResult {
  const problems = [...whatIfProblems(event), ...bookProblems(book), ...termsProblems(terms)];
  if (problems.length > 0) return { ok: false, problems };
  if (event.asset !== undefined && !book.some(h => h.asset === event.asset)) return { ok: false, problems: [`the book holds no ${event.asset}`] };
  if (event.venue !== undefined && !book.some(h => h.venue === event.venue)) return { ok: false, problems: [`the book holds nothing at ${event.venue}`] };

  const shocks: Shock[] = [];
  const parts: string[] = [];
  const name = (asset: string) => book.find(h => h.asset === asset)?.symbol ?? asset;
  if (event.volatileDropPct !== undefined) {
    const held = book.filter(h => h.class === "volatile" && (event.asset === undefined || h.asset === event.asset));
    for (const h of held) shocks.push({ kind: "price", asset: h.asset, factor: 1 - event.volatileDropPct / 100 });
    if (held.length > 0) parts.push(`${held.map(h => name(h.asset)).join(" and ")} fall${held.length === 1 ? "s" : ""} ${event.volatileDropPct}%`);
  }
  if (event.stablePrice !== undefined) {
    const held = book.filter(h => h.class === "stable" && (event.asset === undefined || h.asset === event.asset));
    for (const h of held) shocks.push({ kind: "price", asset: h.asset, factor: event.stablePrice });
    if (held.length > 0) parts.push(`${held.map(h => name(h.asset)).join(" and ")} trade${held.length === 1 ? "s" : ""} at $${event.stablePrice}`);
  }
  if (event.venueOutageDays !== undefined) {
    const venues = [...new Set(book.filter(h => event.venue === undefined || h.venue === event.venue).map(h => h.venue))];
    for (const venue of venues) shocks.push({ kind: "venue-down", venue, days: event.venueOutageDays });
    parts.push(`${venues.join(" and ")} unavailable for ${event.venueOutageDays} day${event.venueOutageDays === 1 ? "" : "s"}`);
  }
  if (event.spendFactor !== undefined) { shocks.push({ kind: "spend", factor: event.spendFactor }); parts.push(`spend at ${event.spendFactor}× plan`); }
  if (event.staleDays !== undefined) { shocks.push({ kind: "sources-stale", days: event.staleDays }); parts.push(`every price source stale for ${event.staleDays} day${event.staleDays === 1 ? "" : "s"}`); }
  // A price event that names nothing the book holds (a stablecoin price on a book of volatile assets only) is no event.
  if (shocks.length === 0) return { ok: false, problems: ["the event touches nothing the book holds"] };

  const label = parts.join("; ");
  const scenario: Scenario = { id: "what-if", label, shocks };
  return { ok: true, label, scenario, now: stressRun(book, terms, { id: "now", label: "Today", shocks: [] }), after: stressRun(book, terms, scenario) };
}
