// What the Hedge section shows (#221), from the server's one read: pure, so it's tested without a browser.
// With its extension: test/hedge-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import type { HedgeRead } from "./proposals-api.ts";

type Move = NonNullable<HedgeRead["plan"]>["moves"][number];
type Code = Move["blocked"][number]["code"];

/** Each blocker in a few words: the planner's own reason follows it, so the owner reads both, never a code alone. */
export const BLOCK_LABEL: Record<Code, string> = {
  not_listed: "Not on the platform's list",
  no_quote: "No live quote",
  stale_quote: "Quote too old",
  quote_size: "Quote too small",
  quote_cost: "Quote too costly",
  risk_level: "Forward risk raised",
  venue_cap: "Over a venue cap",
  class_cap: "Over a class cap",
  order_size: "Over its order limit",
  no_cap: "No cap set",
  cash_floor: "Under the cash floor",
  invalid: "Can't be read",
};

export const KIND_TEXT: Record<Move["kind"], string> = {
  hedge: "Hedge", rebalance: "Top up", trim: "Trim", "depeg-exit": "Leave a depegged coin",
};
export const SHAPE_TEXT: Record<Move["shape"], string> = {
  "stable-to-risk": "stablecoin into a risk asset", "risk-to-stable": "risk asset into a stablecoin",
  "risk-to-risk": "one risk asset into another", "stable-to-stable": "one stablecoin into another",
};
const CLASS: Record<string, string> = { volatile: "Volatile", stable: "Stablecoin", rwa: "Real-world asset" };
const ROUTE: Record<string, string> = { native: "native to NEAR", omft: "NEAR Intents bridge", bridged: "another bridge" };

/** USD with the cents a price needs, "—" when there is none: never a zero standing for a price that wasn't read. */
export const priceText = (value: number | null) => value === null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 4 : 2 })}`;
const usdText = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Where the prices came from and how fresh, in one sentence, with the tone the badge takes. */
export function intentsLine(read: HedgeRead): { tone: "success" | "warning" | "destructive" | "neutral" | "info"; badge: string; text: string } {
  const { source, status, detail, fetchedAt } = read.intents;
  if (status === "off") return { tone: "neutral", badge: "Not connected", text: detail ?? "NEAR Intents isn't connected on this server: there are no live prices or quotes, so every move is blocked." };
  if (status === "unavailable") return { tone: "destructive", badge: "Unavailable", text: `${detail ?? "NEAR Intents couldn't be read."} No move can be priced until it can.` };
  const when = fetchedAt === null ? "" : ` Read ${new Date(fetchedAt).toISOString().slice(11, 19)} UTC.`;
  if (status === "stale") return { tone: "warning", badge: "Stale", text: `${detail ?? "The last list NEAR Intents gave."}${when}` };
  return source === "stub"
    ? { tone: "info", badge: "Simulated", text: `These prices and quotes are simulated by this server, not read from NEAR Intents.${when}` }
    : { tone: "success", badge: "Live", text: `Prices and quotes read from NEAR Intents' public API.${when}` };
}

export type RegistryRow = HedgeRead["registry"][number] & {
  classText: string; routeText: string; priceText: string; heldText: string;
  platformText: "Tradable" | "Not listed"; listText: "On the list" | "Not on the list" | "Not read"; driftText: string[];
};
/** The registry as rows: each asset with its live price, what is held, whether the platform and NEAR Intents list it, and any drift. */
export function registryRows(read: HedgeRead): RegistryRow[] {
  return read.registry.map(r => ({
    ...r,
    classText: CLASS[r.class] ?? r.class,
    routeText: ROUTE[r.route] ?? r.route,
    priceText: priceText(r.priceUsd),
    heldText: r.heldUsd > 0 ? usdText(r.heldUsd) : "—",
    platformText: r.proposable ? "Tradable" : "Not listed",
    listText: r.listed === null ? "Not read" : r.listed ? "On the list" : "Not on the list",
    driftText: r.drift.map(d => `${d.kind}: ${d.detail}`),
  }));
}

export type MoveRow = Move & {
  title: string; kindText: string; shapeText: string; sizeText: string; statusText: "Executable" | "Blocked";
  quoteText: string; blockers: { label: string; reason: string }[];
};
/** The plan's moves as rows: what moves where, how much, what the quote costs, and every reason one can't be proposed. */
export function moveRows(read: HedgeRead): MoveRow[] {
  return (read.plan?.moves ?? []).map(m => ({
    ...m,
    title: `${m.from} → ${m.to}`,
    kindText: KIND_TEXT[m.kind], shapeText: SHAPE_TEXT[m.shape],
    sizeText: usdText(m.sizeUsd),
    statusText: m.status === "executable" ? "Executable" : "Blocked",
    quoteText: m.quote === null ? "No quote" : `${m.quote.costBps.toFixed(1)} bps, ${Math.round(m.quote.ageMs / 1000)} s old`,
    blockers: m.blocked.map(b => ({ label: BLOCK_LABEL[b.code], reason: b.reason })),
  }));
}

/** What the plan says when there are no moves, or no plan: never an empty box. */
export function planNote(read: HedgeRead): string {
  if (!read.plan) return read.problems.join(" ") || "There is no hedge plan.";
  if (read.plan.moves.length === 0) return "Nothing to do: every hedge sleeve is inside its target and ceiling, and the stablecoins are on their split.";
  return "";
}

/** The sentence that says an executable move still needs the owner: it is proposed, then approved with their own signature. */
export const PROPOSE_CAVEAT = "Proposing a move plans it again and puts it on the Proposals page. Nothing is sent until you approve its exact swap with your own signature.";
export const BLOCKED_CAVEAT = "A blocked move is shown so you can see what the book would do once its blockers clear. These caps and checks are app-side: they only hold back, and the platform's signed policy has the last word.";
