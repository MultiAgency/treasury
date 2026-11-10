// What the Agents page shows, from the server's contract: pure, so it's tested without a browser. With its extension:
// test/agents-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { usd } from "../shared/format.ts";
import type { RiskHistory, RiskWhatIf } from "./proposals-api.ts";

/** The what-if events the page offers: each names the field it sets, its unit, a starting value and the range the core accepts. */
export const WHAT_IF_EVENTS = [
  { id: "drop", label: "The volatile asset falls", field: "volatileDropPct", unit: "% in a day", start: "50", min: 1, max: 100 },
  { id: "depeg", label: "The stablecoin trades at", field: "stablePrice", unit: "USD", start: "0.9", min: 0.01, max: 1.5 },
  { id: "outage", label: "The venue is unavailable for", field: "venueOutageDays", unit: "days", start: "7", min: 1, max: 90 },
  { id: "spend", label: "Spend runs at", field: "spendFactor", unit: "× plan", start: "2", min: 0.1, max: 20 },
  { id: "stale", label: "Every price source is stale for", field: "staleDays", unit: "days", start: "1", min: 1, max: 30 },
] as const;
export type WhatIfEventId = (typeof WHAT_IF_EVENTS)[number]["id"];

/** The request for an event and a typed value, or why it can't be asked: nothing is sent for a value that isn't a number in range. */
export function whatIfRequest(id: WhatIfEventId, value: string): { ok: true; request: Record<string, number> } | { ok: false; why: string } {
  const event = WHAT_IF_EVENTS.find(entry => entry.id === id)!;
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n < event.min || n > event.max) return { ok: false, why: `Enter a number from ${event.min} to ${event.max} (${event.unit}).` };
  return { ok: true, request: { [event.field]: n } };
}

const months = (n: number) => `${n.toFixed(1)} months`;

/** The result's rows: today beside after the event, each in words, with the cash floor and trading said plainly. */
export function whatIfRows(result: NonNullable<RiskWhatIf["result"]>) {
  const { now, after } = result;
  return [
    { term: "Book value", now: usd(now.valueUsd), after: usd(after.valueUsd), detail: after.lossUsd > 0 ? `${usd(after.lossUsd)} lost, ${after.drawdownPct.toFixed(1)}%` : "no loss" },
    { term: "Stablecoins left", now: usd(now.stableUsd), after: usd(after.stableUsd), detail: after.unfundedUsd > 0 ? `${usd(after.unfundedUsd)} of spend can't be paid while the venue is down` : "after the spend that falls due" },
    { term: "Runway", now: months(now.runwayMonths), after: months(after.runwayMonths), detail: "months the stablecoins fund at the scenario's spend" },
    { term: "Cash floor", now: now.floorBreached ? "Breached" : "Holds", after: after.floorBreached ? "Breached" : "Holds", detail: `the floor is ${usd(after.floorUsd)} at this spend` },
    { term: "Agent can trade", now: now.tradable ? "Yes" : "No", after: after.tradable ? "Yes" : "No", detail: after.tradable ? "prices fresh and every venue up" : "stale prices or a venue holding the volatile asset is down" },
  ];
}

/** One recent assessment as a row: when, what it recommended in words, and whether it proposed. */
const ACTIONS: Record<RiskHistory["entries"][number]["actions"][number], string> = {
  "hold-buys": "Hold buys", "de-risk": "De-risk", "pause-autopilot": "Pause autopilot", "recommend-freeze": "Consider a freeze",
};
export const actionWords = (actions: RiskHistory["entries"][number]["actions"]) => actions.map(action => ACTIONS[action]);

/** What the agent is doing, in a line: whether this server runs it, how often, and when it last assessed. */
export function statusLine(history: RiskHistory): { running: boolean; text: string } {
  if (!history.configured) return { running: false, text: "This server isn't running the stabilization agent for this treasury: its watch file needs a risk block. Nothing new is assessed." };
  const every = history.intervalS === null ? "on each watch tick" : history.intervalS % 60 === 0 ? `every ${history.intervalS / 60} minutes` : `every ${history.intervalS} seconds`;
  return { running: true, text: `Assessing the book ${every}, beside Ballast, within your signed limits.` };
}
