import { readFileSync } from "node:fs";
import { bindingWindow } from "./budget-window.js";
import { hostedRpc, required } from "./remote.js";
import { totalUsd } from "./valuation.js";

/**
 * Before a demo: check operational preconditions through the hosted dashboard as the
 * signed-in session in REPORT_COOKIE_FILE. Reads only; sends nothing.
 *
 *   DASHBOARD_URL=https://… REPORT_COOKIE_FILE=… pnpm demo-check
 */

const BASE = new URL(required("DASHBOARD_URL"));
const COOKIE = readFileSync(required("REPORT_COOKIE_FILE"), "utf8").trim();
const meResponse = await fetch(new URL("/gw/me", BASE), { headers: { cookie: COOKIE }, redirect: "manual" });
if (!meResponse.ok) throw new Error(`Treasury discovery failed (${meResponse.status})`);
const me = await meResponse.json() as { viewer: unknown; agents: { name: string; area?: string }[] };
if (!me.viewer) throw new Error("A signed-in owner session is required");
const treasuries = me.agents.filter(agent => agent.area === "treasury" || !agent.area && agent.name === "treasury");
const requested = process.env.REPORT_AGENT;
const selected = requested ? treasuries.find(agent => agent.name === requested) : treasuries.length === 1 ? treasuries[0] : undefined;
if (!selected) throw new Error("Select one accessible Treasury agent with REPORT_AGENT");
const rpc = <T>(path: string) => hostedRpc<T>(BASE, COOKIE, selected.name, path);

/** Raw balances arrive as strings (the JSON form of the API's bigints). */
type Holding = { symbol: string; usd: number | null; asset: string; decimals: number; confidential: string };
type Window = { limit_usd: string | null; spent_usd: string; remaining_usd: string | null; resets_at: string | null };
type Period = "daily" | "weekly" | "monthly";
type Overview = { book: Holding[]; target: Record<string, number>; rebalance: { minLegUsd: number }; policy: { usage: { budget: Record<Period, Window> } } };

/** An observation for rehearsal, never authorization or a promise of settlement. */
const expectedUsd = Number(process.env.REPORT_EXPECTED_USD ?? "5");
if (!Number.isFinite(expectedUsd) || expectedUsd <= 0) throw new Error("REPORT_EXPECTED_USD must be positive and finite");
const [treasury, autopilot, unresolved] = await Promise.all([
  rpc<Overview>("overview"),
  rpc<{ on: boolean; nextRun: string | null }>("autopilot/get"),
  rpc<unknown[]>("unresolved"),
]);

// The window that refuses first, as the Overview shows it.
const binding = bindingWindow(treasury.policy.usage.budget);
const left = Number(binding?.remaining_usd ?? Infinity);
const total = totalUsd(treasury.book);
const legs = total === null ? [] : treasury.book.map((h) => ({ symbol: h.symbol, off: h.usd! - (treasury.target[h.asset] ?? 0) * total }));
const largest = legs.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a), { symbol: "-", off: 0 });

const checks: [boolean, string][] = [
  [total !== null, total === null ? "Treasury valuation unavailable: a managed holding lacks a usable USD value; allocation cannot be checked" : "Treasury valuation available"],
  [unresolved.length === 0, `Unresolved operations: ${unresolved.length}`],
  [Boolean(binding) && left >= expectedUsd, binding
    ? `Treasury ${binding.period} budget left: $${left.toFixed(2)} of $${binding.limit_usd} (rehearsal estimate $${expectedUsd}${binding.resets_at ? `; resets ${binding.resets_at}` : ""})`
    : "Treasury budget: no USD limit reported; review the signed policy"],
  [process.env.REPORT_REQUIRE_SCHEDULE !== "true" || autopilot.on, `Schedule ${autopilot.on ? `on, next recorded tick ${autopilot.nextRun ?? "not reported"}` : "off (manual preview remains available)"}`],
];
for (const [ok, line] of checks) console.log(`${ok ? "ok  " : "FIX "} ${line}`);
// Drift is context only; a fresh quote and authorization still decide whether an action can run.
if (total !== null) console.log(`     Treasury book $${total.toFixed(2)}; furthest from target: ${largest.symbol} ${largest.off >= 0 ? "+" : ""}$${largest.off.toFixed(2)} (minimum planned leg $${treasury.rebalance.minLegUsd})`);
process.exitCode = checks.every(([ok]) => ok) ? 0 : 1;
