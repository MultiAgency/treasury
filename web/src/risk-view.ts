// What the agent's forward risk report shows, from the server's contract (#220): pure, so it's tested without a browser.
// With its extension: test/risk-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { symbolOf, usd } from "./shared/format.ts";
import type { RiskReport } from "./proposals-api.ts";

/** A level's wording and tone: never colour alone, and the explanation says what the level does to trades. */
export type LevelView = { label: string; tone: "success" | "info" | "warning" | "destructive"; explanation: string };

export function levelView(level: number): LevelView {
  if (level <= 0) return { label: "L0 normal", tone: "success", explanation: "No forward risk detected: trades follow the saved strategy as usual." };
  if (level === 1) return { label: "L1 watch", tone: "info", explanation: "A forward metric crossed its first step: Ballast holds its buys, and the owner is not asked for anything." };
  if (level === 2) return { label: "L2 caution", tone: "warning", explanation: "A forward metric crossed its second step: every order waits for the owner's approval." };
  if (level === 3) return { label: "L3 critical", tone: "destructive", explanation: "A forward metric crossed its third step: only risk-reducing sells are proposed, each approved by the owner." };
  return { label: "L4 red hand", tone: "destructive", explanation: "Forward risk is at its highest: the agent proposes nothing and recommends the emergency stop, which only the owner can sign." };
}

/** The projection's figures as a row each: what the owner reads first. */
export function metricRows(report: RiskReport) {
  const p = report.projection;
  return [
    { term: "Projected drawdown", value: `${p.projectedDrawdownPct.toFixed(1)}%`, detail: `at ${p.volatileSharePct.toFixed(1)}% volatile` },
    { term: "Expected shortfall", value: `${p.expectedShortfallPct.toFixed(1)}%`, detail: "mean loss over the worst paths" },
    { term: "Chance of breaching the cash floor", value: `${p.breachProbabilityPct.toFixed(1)}%`, detail: "some day in the horizon" },
    { term: "Months to the cash floor", value: p.monthsToFloor < 0 ? "under it now" : `${p.monthsToFloor.toFixed(1)}`, detail: `runway ${p.runwayMonths.toFixed(1)} months at plan spend` },
  ];
}

/** The most severe scenarios, as the agent recorded them (already most severe first), cut to what the page shows. */
export function topScenarios(report: RiskReport, limit = 3) {
  return report.scenarios.slice(0, limit).map(s => ({
    id: s.id,
    label: s.label,
    drawdown: `${s.drawdownPct.toFixed(1)}%`,
    runway: `${s.runwayMonths.toFixed(1)} months`,
    floor: s.floorBreached ? "Breaches the cash floor" : "Keeps the cash floor",
  }));
}

/** What each recommendation says for a person: the de-risk names its size and whether it was proposed, the rest why. */
export function recommendationRows(report: RiskReport) {
  return report.recommendations.map(r => {
    if (r.action === "de-risk") {
      const what = `Sell ${usd(r.sizeUsd)} of ${symbolOf(r.asset, [])} into ${symbolOf(r.into, [])}`;
      const state = r.blocked !== null ? `Not proposed: ${r.blocked}.`
        : report.proposed ? "Proposed for your approval." : "Recommended, not proposed.";
      return { action: r.action, label: "De-risk", text: `${what}. ${state} ${r.reason}` };
    }
    if (r.action === "pause-autopilot") return { action: r.action, label: "Pause autopilot", text: `${r.reason} Pausing it is yours to do on the Strategy page.` };
    if (r.action === "recommend-freeze") return { action: r.action, label: "Consider a freeze",
      text: `${r.reason} A freeze is a recommendation only: this agent cannot freeze anything, and the emergency stop takes effect once you sign it.` };
    return { action: r.action, label: "Hold buys", text: r.reason };
  });
}

/** The scenario a reader should see first, when there is one: its label and the floor's answer. */
export const worstScenario = (report: RiskReport) => topScenarios(report, 1)[0] ?? null;
