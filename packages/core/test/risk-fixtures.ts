// Shared inputs for the stabilization tests (#220): a balanced book, its mandate's policy, and seeded price histories.
import { compileMandate, policyConfigOf, PROJECTION_DEFAULTS, PROPOSAL_ASSETS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS, syntheticSeries,
  type Book, type RiskInput, type Sample } from "../src/index.ts";

export const H = 3_600_000, DAY = 24 * H;
export const AT = 1_800_000_000_000;
export const WNEAR = PROPOSAL_ASSETS.wNEAR, USDC = PROPOSAL_ASSETS.USDC;

/** 40,000 USD of wNEAR and 60,000 of USDC, all at NEAR Intents: the balanced profile's weights, spending 2,000 a month. */
export const book = (volatileUsd = 40_000, stableUsd = 60_000): Book => [
  { asset: WNEAR, symbol: "wNEAR", class: "volatile", usd: volatileUsd, venue: "NEAR Intents" },
  { asset: USDC, symbol: "USDC", class: "stable", usd: stableUsd, venue: "NEAR Intents" },
];
export const terms = { monthlySpendUsd: 2_000, operatingCashMonths: 6 };

/** Hourly prices ending at `at`: a seeded walk of `days` days, ±`volPct` a step, `driftPct` a step. */
export const walk = (days: number, volPct: number, driftPct = 0, seed = 1, at = AT): Sample[] =>
  syntheticSeries({ startAt: at - days * DAY, startPrice: 4, count: days * 24 + 1, stepMs: H, stepVolPct: volPct, driftPct, seed });

/** Two calm weeks, then a fall of `pct` percent over the last `hours` hours: a crash in progress. */
export function crash(pct: number, hours = 24, at = AT): Sample[] {
  const calm = walk(15, 1, 0, 7, at);
  const startAt = at - hours * H, from = calm.find(s => s.at === startAt)!.price;
  return calm.map(s => s.at <= startAt ? s : { at: s.at, price: from * (1 - pct / 100 * (s.at - startAt) / (hours * H)) });
}

const mandate = compileMandate({ monthlySpendUsd: 2_000, operatingCashMonths: 6, treasuryValueUsd: 100_000, volatileAssets: ["wNEAR"], stablecoins: ["USDC"],
  destinations: ["ops.near"], approvers: ["owner.near"] }, "balanced");
if (!mandate.ok) throw new Error(mandate.problems.join("; "));
export const balanced = mandate.mandate;

/** An assessment's input for the balanced book at `AT`, with `change` applied. */
export function riskInput(history: Sample[], change: Partial<RiskInput> = {}, trade: Partial<RiskInput["trade"]> = {}): RiskInput {
  return {
    at: AT, book: book(), terms, history: { [WNEAR]: history }, thresholds: RISK_PROFILE_DEFAULTS.balanced,
    projection: PROJECTION_DEFAULTS, scenarios: SCENARIO_DEFAULTS, autopilotOn: false,
    trade: {
      turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, cashUsd: 12_000, config: policyConfigOf(balanced), bounds: balanced.bounds,
      baseLevel: 0, lastActionAt: null, cooldownMs: 3_600_000,
      pricing: { prices: { [WNEAR]: "4", [USDC]: "1" }, decimals: { [WNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 100 }, ...trade,
    },
    ...change,
  };
}
