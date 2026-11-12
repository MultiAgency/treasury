import assert from "node:assert/strict";
import { test } from "node:test";
import { levelView, metricRows, recommendationRows, topScenarios, worstScenario } from "../src/risk-view.ts";
import type { RiskReport } from "../src/server-api.ts";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";

const report: RiskReport = {
  at: "2026-11-06T12:00:00.000Z", seq: 42, level: 2,
  reason: "projected drawdown 22.6% is at or past its L2 step, 16%",
  projection: { usable: true, reasons: [], projectedDrawdownPct: 22.62, expectedShortfallPct: 22.66, breachProbabilityPct: 4.2, runwayMonths: 30, monthsToFloor: 24, volatileSharePct: 40 },
  scenarios: [
    { id: "drop:wNEAR:80", label: "wNEAR falls 80% in a day", valueUsd: 68_000, lossUsd: 32_000, drawdownPct: 32, stableUsd: 60_000, runwayMonths: 30, floorUsd: 12_000, floorBreached: false, unfundedUsd: 0, tradable: true },
    { id: "depeg:USDC:0.9", label: "USDC trades at $0.9", valueUsd: 94_000, lossUsd: 6_000, drawdownPct: 6, stableUsd: 54_000, runwayMonths: 27, floorUsd: 12_000, floorBreached: false, unfundedUsd: 0, tradable: true },
    { id: "spend:2x", label: "Spend at 2× plan", valueUsd: 100_000, lossUsd: 0, drawdownPct: 0, stableUsd: 60_000, runwayMonths: 15, floorUsd: 24_000, floorBreached: false, unfundedUsd: 0, tradable: true },
    { id: "venue:NEAR Intents:7d", label: "NEAR Intents unavailable for 7 days", valueUsd: 100_000, lossUsd: 0, drawdownPct: 0, stableUsd: 59_533.33, runwayMonths: 29.77, floorUsd: 12_000, floorBreached: true, unfundedUsd: 466.67, tradable: false },
  ],
  recommendations: [
    { action: "hold-buys", reason: "Ballast holds its trades, buys included, while forward risk is raised." },
    { action: "de-risk", asset: WNEAR, into: USDC, sizeUsd: 2_000, reason: "Sell 2,000 USD of wNEAR into USDC.", blocked: null },
    { action: "pause-autopilot", reason: "Autopilot rebalances to the saved targets on its own." },
    { action: "recommend-freeze", reason: "Expected shortfall is high." },
  ],
  derisk: { sizeUsd: 2_000, blocked: null },
  proposed: true,
};

test("each forward level has words and a tone, never colour alone; past L4 stays the red hand", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(level => levelView(level).label), ["L0 normal", "L1 watch", "L2 caution", "L3 critical", "L4 red hand"]);
  assert.deepEqual([0, 1, 2, 3, 4].map(level => levelView(level).tone), ["success", "info", "warning", "destructive", "destructive"]);
  assert.match(levelView(2).explanation, /waits for the owner's approval/);
  assert.equal(levelView(9).label, "L4 red hand");
});

test("the projection's figures are rows a person reads: percents, months, and a floor already under", () => {
  assert.deepEqual(metricRows(report).map(row => [row.term, row.value]), [
    ["Projected drawdown", "22.6%"],
    ["Expected shortfall", "22.7%"],
    ["Chance of breaching the cash floor", "4.2%"],
    ["Months to the cash floor", "24.0"],
  ]);
  assert.deepEqual(metricRows({ ...report, projection: { ...report.projection, monthsToFloor: -1 } })[3]!.value, "under it now");
});

test("the top three scenarios keep the agent's severity order, each with its drawdown, runway and the floor's answer", () => {
  assert.deepEqual(topScenarios(report).map(s => s.id), ["drop:wNEAR:80", "depeg:USDC:0.9", "spend:2x"]);
  assert.deepEqual(topScenarios(report)[0], { id: "drop:wNEAR:80", label: "wNEAR falls 80% in a day", drawdown: "32.0%", runway: "30.0 months", floor: "Keeps the cash floor" });
  assert.deepEqual(topScenarios(report, 1)[0]!.floor, "Keeps the cash floor");
  assert.equal(topScenarios({ ...report, scenarios: [] }).length, 0);
  assert.equal(worstScenario(report)!.id, "drop:wNEAR:80");
  assert.equal(worstScenario({ ...report, scenarios: [] }), null);
  const breached = { ...report, scenarios: [{ ...report.scenarios[3]! }, ...report.scenarios.slice(0, 3)] };
  assert.equal(topScenarios(breached)[0]!.floor, "Breaches the cash floor");
});

test("a de-risk is shown with its size and whether it was proposed, and a freeze is only ever a recommendation", () => {
  const rows = recommendationRows(report);
  assert.deepEqual(rows.map(row => row.label), ["Hold buys", "De-risk", "Pause autopilot", "Consider a freeze"]);
  assert.match(rows[1]!.text, /^Sell \$2,000\.00 of wNEAR into USDC\. Proposed for your approval\./);
  assert.match(rows[2]!.text, /yours to do on the Strategy page/);
  assert.match(rows[3]!.text, /recommendation only: this agent cannot freeze anything, and the emergency stop takes effect once you sign it/);

  const blocked = recommendationRows({ ...report, proposed: false, recommendations: [{ ...report.recommendations[1]!, blocked: "a trade was proposed within the cooldown" } as RiskReport["recommendations"][number]] });
  assert.match(blocked[0]!.text, /Not proposed: a trade was proposed within the cooldown\./);
  const notProposed = recommendationRows({ ...report, proposed: false, recommendations: [report.recommendations[1]!] });
  assert.match(notProposed[0]!.text, /Recommended, not proposed\./);
});


test("an unusable projection never exposes conservative fallback figures as forecasts", () => {
  const unavailable = { ...report, projection: { usable: false, reasons: ["missing ETH history"],
    projectedDrawdownPct: 100, expectedShortfallPct: 100, breachProbabilityPct: 100,
    runwayMonths: 0, monthsToFloor: 0, volatileSharePct: 100 } };
  assert.deepEqual(metricRows(unavailable), []);
  assert.deepEqual(topScenarios(unavailable), topScenarios(report), "deterministic stress scenarios remain available");
});
