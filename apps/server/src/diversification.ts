// The agent's diversified book as the app reports it (#221), from one `overview` read: each holding with its class,
// chain, route and venues, the exposure and cap of every venue, the stablecoin split with each coin's peg level, and
// what each phase needs before it can run. Pure: no platform call, no clock beyond the passed one, and no assumption
// that a registry entry is tradable. Caps come from the agent's own mandate terms when its watch config carries them;
// otherwise the profile's defaults are marked as such, or no cap is shown. An app-side cap only holds back: the
// platform's signed policy has the last word (CONTRIBUTING).
//
// The route test (test/diversification.test.ts) reaches it through the server, which resolves only explicit `.ts` paths.

import type { OwnerOutput } from "@multiagency/sdk";
import {
  assetById, assetBySymbol, bookExposure, compileMandate, diversificationDefaults, diversificationPhases, pegLevel,
  proposable, PROFILE_DEFAULTS, STABLE_DEFAULTS, VENUES,
  type AssetEntry, type AssetClass, type DiversifiedTerms, type IntentsRoute, type MandateFrame, type ProfileName,
} from "../../../packages/core/src/index.ts";
import { configTreasuryOf, mandateAnswersOf, type BallastSettings } from "./ballast.ts";
import { diversificationRead } from "./contract.ts";

type Read = OwnerOutput<"overview">;
type View = import("zod").z.output<typeof diversificationRead>;
type CapSource = View["venues"][number]["capSource"];

/** The registry's entry for a platform book row: by its NEAR Intents id, else by the symbol the platform shows. */
const entryOf = (row: Read["book"][number]): AssetEntry | undefined => assetById(row.asset) ?? assetBySymbol(row.symbol);

/**
 * The terms to report against: the agent's compiled mandate when its watch config sets the block, the profile's
 * defaults when it sets only a profile, else none. Compiling against the book's value can refuse (a floor the cash
 * share can no longer hold); the configured terms are still shown, with a note that the mandate doesn't compile now.
 */
function termsOf(settings: BallastSettings | undefined, total: number): { terms: DiversifiedTerms | null; source: View["source"]; notes: string[] } {
  if (!settings) return { terms: null, source: "absent", notes: ["no Ballast settings are configured for this agent: the caps shown are absent"] };
  const notes: string[] = [];
  if (!settings.diversification) {
    const profile = PROFILE_DEFAULTS[settings.profile as ProfileName];
    const frame: MandateFrame = {
      weights: profile.weights, bounds: profile.bounds, assets: { volatile: ["wNEAR"], stablecoins: ["USDC"] },
      maxVenueExposurePct: profile.bounds.volatileMaxPct,
    };
    notes.push("no diversification block is configured for this agent: the caps are the profile's defaults, not signed terms");
    return { terms: diversificationDefaults(settings.profile as ProfileName, frame), source: "profile-defaults", notes };
  }
  // The config was checked at load against a treasury that can hold its floor; the live book may not be able to.
  const compiled = compile(settings, total);
  if (compiled.ok) return { terms: compiled.terms, source: "mandate", notes };
  const fallback = compile(settings, configTreasuryOf(settings));
  if (!fallback.ok) return { terms: null, source: "absent", notes: [...notes, `the diversification terms don't compile: ${fallback.problems.join("; ")}`] };
  return { terms: fallback.terms, source: "mandate", notes: [...notes, `the mandate doesn't compile against the book's value now: ${compiled.problems.join("; ")}`] };
}

type Compiled = { ok: true; terms: DiversifiedTerms } | { ok: false; problems: string[] };

function compile(settings: BallastSettings, treasuryValueUsd: number): Compiled {
  // Imported here rather than at the top only because the compiler lives with the mandate; one call site keeps the
  // requirement that nothing is read as terms the compiler refused.
  const result = compileMandate(mandateAnswersOf(settings, treasuryValueUsd), settings.profile as ProfileName);
  if (!result.ok) return { ok: false, problems: result.problems };
  return result.mandate.diversification ? { ok: true, terms: result.mandate.diversification } : { ok: false, problems: ["no diversification terms"] };
}

/**
 * The view: per holding its class, chain, route, venues, USD value and whether the platform can propose it; per venue
 * its exposure and cap with where the cap came from; the stablecoins held with their peg level and split target; and
 * each phase with every reason it can't run. Unpriced or unknown holdings make the venue exposures unknown, never a
 * smaller number presented as complete.
 */
export function diversificationView(overview: Read, settings: BallastSettings | undefined): View {
  const rows = overview.book;
  const known = rows.map(row => ({ row, entry: entryOf(row) }));
  const priced = known.every(({ row }) => row.usd !== null && Number.isFinite(row.usd));
  const allKnown = known.every(({ entry }) => entry !== undefined);
  const total = priced ? rows.reduce((sum, row) => sum + (row.usd ?? 0), 0) : 0;
  const { terms, source, notes } = termsOf(settings, total);
  if (!priced) notes.push("some holdings have no USD value: the venue exposures are unknown, never a partial total");
  if (!allKnown) notes.push("some holdings aren't in the asset registry: the venue exposures are unknown");

  const holdings: View["holdings"] = known.map(({ row, entry }) => ({
    asset: row.asset, symbol: row.symbol,
    class: (entry?.class ?? null) as AssetClass | null,
    chain: entry?.chain ?? null,
    route: (entry?.route ?? null) as IntentsRoute | null,
    venues: entry ? [...entry.venues] : [],
    usd: row.usd, proposable: entry !== undefined && proposable(entry),
  }));

  const exposure = allKnown && priced ? bookExposure(known.map(({ entry, row }) => ({ asset: entry!.symbol, usd: row.usd! }))) : null;
  const capOf = (venue: string): { capPct: number | null; capSource: CapSource } => {
    const cap = terms?.venueCapsPct[venue];
    if (cap !== undefined) return { capPct: cap, capSource: source === "mandate" ? "mandate" : "profile-default" };
    return { capPct: null, capSource: "absent" };
  };
  const venues: View["venues"] = Object.values(VENUES).map(venue => ({
    id: venue.id, label: venue.label, kind: venue.kind,
    exposureUsd: exposure ? (exposure.venueUsd[venue.id] ?? 0) : null,
    ...capOf(venue.id),
  }));

  const stableTotal = known.reduce((sum, { row, entry }) => sum + (entry?.class === "stable" ? (row.usd ?? 0) : 0), 0);
  const stablecoins: View["stablecoins"] = known.flatMap(({ row, entry }) => {
    if (entry?.class !== "stable") return [];
    const price = row.price;
    return [{
      symbol: entry.symbol, usd: row.usd ?? 0, price,
      sharePct: stableTotal > 0 ? ((row.usd ?? 0) / stableTotal) * 100 : null,
      targetPct: terms?.stableSplit[entry.symbol] ?? null,
      peg: pegLevel(price, entry.pegUsd ?? Number.NaN, STABLE_DEFAULTS.depegPct),
    }];
  });
  // A coin the split names but the book doesn't hold is still part of the split: show it at zero with no price, so the
  // target isn't hidden. It can't be traded until the platform lists it (the phase reasons say so).
  for (const coin of Object.keys(terms?.stableSplit ?? {})) {
    if (stablecoins.some(s => s.symbol === coin)) continue;
    stablecoins.push({ symbol: assetBySymbol(coin)?.symbol ?? coin, usd: 0, price: null, sharePct: 0,
      targetPct: terms?.stableSplit[coin] ?? null, peg: 3 });
  }

  const phases = diversificationPhases(terms).phases.map(phase => ({ phase: phase.phase, title: phase.title, on: phase.on, reasons: phase.reasons }));
  return { source, profile: settings ? settings.profile as ProfileName : null, holdings, venues, stablecoins, phases, notes };
}
