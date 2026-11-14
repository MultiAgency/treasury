// What the Diversification section shows (#221), from the server's one read: pure, so it's tested without a browser.
// With its extension: test/diversification-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import type { DiversificationRead } from "./server-api.ts";

export type HoldingView = DiversificationRead["holdings"][number] & { classText: string; platformText: string; venuesText: string };
export type VenueView = DiversificationRead["venues"][number] & { exposureText: string; capText: string; capNote: string };
export type StableView = DiversificationRead["stablecoins"][number] & { shareText: string; targetText: string; pegText: string; pegTone: "success" | "warning" | "destructive" | "neutral" };
export type PhaseView = DiversificationRead["phases"][number] & { badge: "On" | "Off"; reasonsText: string };

const CLASS: Record<string, string> = { volatile: "Volatile", stable: "Stablecoin", rwa: "Real-world asset" };
const CAP_SOURCE: Record<string, string> = { mandate: "from the configured terms", "profile-default": "the profile's default", absent: "no cap configured" };

/** A USD amount, or "—" when the value couldn't be read; never a partial total shown as one. */
const usd = (value: number | null) => value === null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;

export function holdingViews(read: DiversificationRead): HoldingView[] {
  return read.holdings.map(h => ({
    ...h,
    classText: h.class ? CLASS[h.class]! : "Not in the registry",
    platformText: h.proposable ? "Tradable" : "Not listed",
    venuesText: h.venues.length ? h.venues.join(", ") : "—",
  }));
}

export function venueViews(read: DiversificationRead): VenueView[] {
  return read.venues.map(v => ({
    ...v,
    exposureText: usd(v.exposureUsd),
    capText: v.capPct === null ? "No cap" : percent(v.capPct),
    capNote: CAP_SOURCE[v.capSource]!,
  }));
}

/** The stablecoins as rows: each one's peg level (0 on peg, 2 or 3 off it), its share now and its target. */
export function stableViews(read: DiversificationRead): StableView[] {
  return read.stablecoins.map(s => ({
    ...s,
    shareText: percent(s.sharePct),
    targetText: percent(s.targetPct),
    // A split coin the book doesn't hold has no price; that's "No price", not a depeg.
    pegText: s.price === null ? "No price" : s.peg === 0 ? "On peg" : `L${s.peg} depeg`,
    pegTone: s.price === null ? "neutral" : s.peg === 0 ? "success" : s.peg === 2 ? "warning" : "destructive",
  }));
}

/** The phases, each with its switch and every reason it can't run, joined for a title and listed in full by the page. */
export function phaseViews(read: DiversificationRead): PhaseView[] {
  return read.phases.map(p => ({ ...p, badge: p.on ? "On" : "Off", reasonsText: p.reasons.join(" ") }));
}

/** Why caps aren't the platform's: one line the page states once, above the tables. */
export const CAP_CAVEAT = "These caps are app-side: the engine refuses to propose past them, but only the platform's signed policy enforces what executes.";

/** Where the caps came from, in the page's words. */
export const sourceText = (source: DiversificationRead["source"]) => source === "mandate"
  ? "Caps from the agent's configured mandate terms."
  : source === "profile-defaults" ? "No diversification block is configured: these are the profile's defaults, not signed terms."
  : "No mandate or profile is configured for this agent: no caps are shown.";
