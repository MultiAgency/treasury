// #220's backtest: Ballast's bands alone beside the stabilization agent, on the same price history.
//
//   node scripts/stabilization-backtest.ts run                       # the deterministic synthetic placeholder, writes the report
//   node scripts/stabilization-backtest.ts run --csv near-usd-1h.csv # a real hourly `timestamp,price` series, 12+ months
//   node scripts/stabilization-backtest.ts run --out <path>          # where the report goes (default docs/stabilization-backtest.md)
//
// The synthetic series is a placeholder until the real hourly history is loaded (H5/A8.2): a seeded random walk with the
// issue's 50% crash in six hours, a month at the low, and a two-month recovery. It is never presented as market history. The
// report carries the SHA-256 of the series, the configuration and both together, so two runs on the same inputs can be
// compared; the same inputs always give the same numbers.
//
// Both arms run the same engines through the same loop: Ballast's oracle, bands, anti-whipsaw and policy; the
// stabilization arm adds `assessRisk` before the bands each hour, and when it sizes a de-risk sell that passes policy and
// the cooldown, that sell is the hour's one trade. The backtest assumes the owner approves each de-risk proposal (in
// production each is a proposal they sign), and it charges both arms the same fixed 5 bps of slippage.

import { readFileSync, writeFileSync } from "node:fs";
import {
  assessRisk, checkPolicy, compileMandate, detectMarketMoves, ENGINE_DEFAULTS, evaluateBands, highestLevel, nextState,
  parseHistory, policyConfigOf, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, readOracle, regimeFrom, REPLAY_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS,
  SimulatedProvider, syntheticSeries, weightBoundsOf,
  type EngineConfig, type EquityPoint, type Fill, type FullContext, type Portfolio, type RiskAssessment, type RiskInput, type Sample, type WhipsawState,
} from "../packages/core/src/index.ts";
import { canonicalJson, sha256Hex } from "../packages/core/src/digest.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** The synthetic history: 300 days after 35 days of EMA warm-up, starting 2025-01-01 UTC. */
export const START = Date.UTC(2025, 0, 1);
export const DAYS = 300, WARMUP_DAYS = 35;
/** A 50% fall over six hours at day 180, a month at the low, then a two-month recovery: the issue's tail event. */
export const CRASH_DAY = 180;
/** The backtest's own projection cost: 200 paths instead of 500, so 300 days can be assessed every hour. */
const BACKTEST_PROJECTION = { ...PROJECTION_DEFAULTS, paths: 200 } as const;
const BALANCED = (() => {
  const mandate = compileMandate({ monthlySpendUsd: 2_000, operatingCashMonths: 6, treasuryValueUsd: 100_000, volatileAssets: ["wNEAR"], stablecoins: ["USDC"],
    destinations: ["ops.near"], approvers: ["owner.near"] }, "balanced");
  if (!mandate.ok) throw new Error(mandate.problems.join("; "));
  return mandate.mandate;
})();
const START_PORTFOLIO: Portfolio = { volatileUsd: 40_000, reserveUsd: 35_000, cashUsd: 25_000 };
const CONFIG = {
  engine: ENGINE_DEFAULTS, policy: policyConfigOf(BALANCED), oracle: REPLAY_DEFAULTS.oracle, smoothing: REPLAY_DEFAULTS.smoothing,
  bounds: weightBoundsOf(BALANCED), asset: "wNEAR", sources: ["a", "b", "c"], seed: 220,
  provider: { baseSlippageBps: 5, jitterSlippageBps: 0 },
};
const RISK = { thresholds: RISK_PROFILE_DEFAULTS.balanced, projection: BACKTEST_PROJECTION, scenarios: SCENARIO_DEFAULTS };
const VENUE = "NEAR Intents";
const WNEAR_ID = PROPOSAL_ASSETS.wNEAR, USDC_ID = PROPOSAL_ASSETS.USDC;

/** The deterministic placeholder: a seeded walk with the tail event laid over it. */
export function syntheticPlaceholder(): { warmup: Sample[]; series: Sample[] } {
  const walk = syntheticSeries({ startAt: START - WARMUP_DAYS * DAY, startPrice: 4, count: (WARMUP_DAYS + DAYS) * 24, stepMs: HOUR, stepVolPct: 0.8, driftPct: 0, seed: 220 });
  const warmup = walk.slice(0, WARMUP_DAYS * 24), series = walk.slice(WARMUP_DAYS * 24).map((sample, i) => ({ at: sample.at, price: sample.price * window(i) }));
  return { warmup, series };
}
/** The crash window: 1 down to 0.5 over six hours of day 180, held for a month, back to 1 over two months. */
function window(i: number): number {
  const hour = i % 24, day = Math.floor(i / 24);
  if (day < CRASH_DAY) return 1;
  // A six-hour crash, not a day-long slide: the projection's recent-volatility term sees it while it happens.
  if (day === CRASH_DAY) return hour < 6 ? 1 - 0.5 * (hour + 1) / 6 : 0.5;
  if (day < CRASH_DAY + 30) return 0.5;
  if (day < CRASH_DAY + 90) return 0.5 + 0.5 * (day - CRASH_DAY - 30) / 60;
  return 1;
}

type Arm = {
  name: string;
  trades: Fill[];
  equity: EquityPoint[];
  firstDeRiskAt: number | null;
  firstBallastSellAt: number | null;
  minStableUsd: number;
  finalStableUsd: number;
  finalValueUsd: number;
  maxDrawdownPct: number;
  riskRaised: number;
};

/** The loop both arms share: one reading an hour, the stabilization step first when the arm has it, then the bands. */
export function runArm(name: string, { warmup, series }: { warmup: Sample[]; series: Sample[] }, risk?: typeof RISK): Arm {
  const history: Sample[] = [...warmup];
  const provider = new SimulatedProvider(CONFIG.seed, CONFIG.provider);
  const trades: Fill[] = [], equity: EquityPoint[] = [];
  let qty = START_PORTFOLIO.volatileUsd / series[0]!.price, reserve = START_PORTFOLIO.reserveUsd;
  const cash = START_PORTFOLIO.cashUsd;
  let state: WhipsawState = {}, dcaUnitsUsed = 0, lastPrice = series[0]!.price, firstDeRiskAt: number | null = null, firstBallastSellAt: number | null = null;
  let minStableUsd = reserve + cash, riskRaised = 0;
  for (const [i, sample] of series.entries()) {
    const { at, price } = sample;
    lastPrice = price;
    const quotes = CONFIG.sources.map(source => ({ source, asset: CONFIG.asset, price, observedAt: at }));
    const reading = readOracle(CONFIG.asset, quotes, history, at, CONFIG.oracle, CONFIG.smoothing);
    history.push(sample);
    let volatileUsd = qty * price;
    let stableUsd = reserve + cash;
    const market = detectMarketMoves(history, at);
    const baseLevel = highestLevel(market) as 0 | 1 | 2 | 3 | 4;
    let assessment: RiskAssessment | undefined;
    if (risk) {
      const from = at - risk.projection.lookbackDays * DAY - risk.projection.maxGapMs;
      const input: RiskInput = {
        at,
        book: [{ asset: WNEAR_ID, symbol: "wNEAR", class: "volatile", usd: volatileUsd, venue: VENUE },
          { asset: USDC_ID, symbol: "USDC", class: "stable", usd: stableUsd, venue: VENUE }],
        terms: { monthlySpendUsd: 2_000, operatingCashMonths: 6 },
        history: { [WNEAR_ID]: history.filter(s => s.at >= from) },
        thresholds: risk.thresholds, projection: risk.projection, scenarios: risk.scenarios, autopilotOn: false,
        trade: { turnoverTodayUsd: trades.filter(t => t.at > at - DAY).reduce((sum, t) => sum + t.sizeUsd, 0),
          ordersLastHour: trades.filter(t => t.at > at - HOUR).length, quotedSlippageBps: CONFIG.provider.baseSlippageBps, cashUsd: cash,
          config: CONFIG.policy, bounds: CONFIG.bounds, baseLevel, lastActionAt: state.lastActionAt ?? null,
          cooldownMs: ENGINE_DEFAULTS.whipsaw.cooldownMs,
          pricing: { prices: { [WNEAR_ID]: price.toFixed(12), [USDC_ID]: "1" }, decimals: { [WNEAR_ID]: 24, [USDC_ID]: 6 }, maxSlippageBps: CONFIG.policy.limits.maxSlippageBps } },
      };
      assessment = assessRisk(input);
      if (assessment.level > 0) riskRaised++;
      const proposed = assessment.derisk?.proposal;
      if (proposed) {
        const intent = assessment.derisk!.intent;
        const quote = provider.quote(intent.id);
        const filled = quote === null ? { ok: false as const } : provider.fill(intent, price);
        if (filled.ok) {
          trades.push(filled.fill);
          reserve += filled.fill.quantity * filled.fill.fillPrice;
          qty -= filled.fill.quantity;
          state = nextState(state, intent, null, at);
          if (firstDeRiskAt === null) firstDeRiskAt = at;
          volatileUsd = qty * price;
          stableUsd = reserve + cash;
          equity.push({ at, valueUsd: volatileUsd + stableUsd });
          minStableUsd = Math.min(minStableUsd, stableUsd);
          continue;
        }
      }
    }
    const forward = assessment?.detections ?? [];
    const level = Math.max(baseLevel, assessment?.level ?? 0) as 0 | 1 | 2 | 3 | 4;
    const portfolio: Portfolio = { volatileUsd, reserveUsd: reserve, cashUsd: cash };
    const intent = evaluateBands(reading, { portfolio, bounds: CONFIG.bounds, sizing: { dcaUnitsUsed }, whipsaw: state, regime: regimeFrom([...market, ...forward]) },
      CONFIG.engine as EngineConfig);
    const deviation = reading.frozen ? null : (reading.twap15m / reading.ema30d - 1) * 100;
    if (reading.frozen || intent.action === "hold") {
      state = nextState(state, intent, deviation, at);
      equity.push({ at, valueUsd: volatileUsd + stableUsd });
      minStableUsd = Math.min(minStableUsd, stableUsd);
      continue;
    }
    const quoted = provider.quote(intent.id);
    const ctx: FullContext = {
      treasuryValueUsd: volatileUsd + stableUsd, turnoverTodayUsd: trades.filter(t => t.at > at - DAY).reduce((sum, t) => sum + t.sizeUsd, 0),
      ordersLastHour: trades.filter(t => t.at > at - HOUR).length, quotedSlippageBps: quoted,
      venueExposureUsd: volatileUsd, cashUsd: cash, spendsCashUsd: 0, level,
    };
    const verdict = checkPolicy(intent, ctx, CONFIG.policy);
    // A band trade needs a human only if the level says so: in a backtest there is none, so it isn't filled, and it
    // arms nothing: the state changes only for a hold or a fill, as `replay` does.
    if (verdict.ok !== true || quoted === null) {
      equity.push({ at, valueUsd: volatileUsd + stableUsd });
      minStableUsd = Math.min(minStableUsd, stableUsd);
      continue;
    }
    const filled = provider.fill(intent, price);
    if (filled.ok) {
      trades.push(filled.fill);
      if (filled.fill.action === "buy-volatile") { reserve -= filled.fill.sizeUsd; qty += filled.fill.quantity; dcaUnitsUsed += intent.dcaUnits; }
      else { reserve += filled.fill.quantity * filled.fill.fillPrice; qty -= filled.fill.quantity; if (firstBallastSellAt === null) firstBallastSellAt = at; }
    }
    state = nextState(state, intent, deviation, at);
    equity.push({ at, valueUsd: qty * price + reserve + cash });
    minStableUsd = Math.min(minStableUsd, reserve + cash);
  }
  return { name, trades, equity, firstDeRiskAt, firstBallastSellAt, minStableUsd, finalStableUsd: reserve + cash, finalValueUsd: qty * lastPrice + reserve + cash,
    maxDrawdownPct: maxDrawdown(equity), riskRaised };
}

/** The deepest fall from a running high in the treasury's value. */
export function maxDrawdown(equity: readonly EquityPoint[]): number {
  let peak = -Infinity, worst = 0;
  for (const { valueUsd } of equity) {
    if (valueUsd > peak) peak = valueUsd;
    else if (peak > 0) worst = Math.max(worst, (peak - valueUsd) / peak * 100);
  }
  return worst;
}

const iso = (at: number | null) => at === null ? "never" : new Date(at).toISOString().slice(0, 16).replace("T", " ");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const months = (n: number) => (n < 0 ? "under it" : `${n.toFixed(1)}`);
const day = (at: number | null) => at === null ? "—" : `${((at - START) / DAY).toFixed(1)}`;

function reportFor({ warmup, series }: { warmup: Sample[]; series: Sample[] }, source: string): string {
  const ballast = runArm("Ballast's bands alone", { warmup, series });
  const stabilized = runArm("With the stabilization agent", { warmup, series }, RISK);
  const floorUsd = 2_000 * 6, monthly = 2_000;
  const seriesDigest = sha256Hex(canonicalJson({ warmup, series }));
  const configDigest = sha256Hex(canonicalJson({ start: START_PORTFOLIO, config: CONFIG, risk: RISK, floorUsd }));
  const inputsDigest = sha256Hex(canonicalJson({ series: seriesDigest, config: configDigest }));
  const rows = [ballast, stabilized].map(arm => `| ${arm.name} | ${iso(arm.firstDeRiskAt)} | ${iso(arm.firstBallastSellAt)} | ${pct(arm.maxDrawdownPct)} | ${money(arm.finalValueUsd)} | ${money(arm.minStableUsd)} | ${months((arm.minStableUsd - floorUsd) / monthly)} | ${arm.riskRaised} | ${arm.trades.length} |`);
  const earlier = ballast.firstBallastSellAt === null || (stabilized.firstDeRiskAt !== null && stabilized.firstDeRiskAt < ballast.firstBallastSellAt);
  const aboveFloor = [ballast, stabilized].every(arm => arm.minStableUsd >= floorUsd);
  return `# Stabilization backtest (#220)

**Generated output:** \`node scripts/stabilization-backtest.ts run\`. Do not edit by hand; rerun the script. It is the
comparison the issue asks for: Ballast's bands alone against the stabilization agent, on the same hourly history.

> **The history here is a deterministic synthetic placeholder, not market history.** It is a seeded random walk with the
> issue's 50% six-hour crash laid over it (day ${CRASH_DAY}), a month at the low and a two-month recovery, so the machinery and
> the report can be exercised before A8.2/H5 load real hourly NEAR-USD. No number below says what the agent would have done
> in a real market, and none is evidence of returns. \`run --csv <file>\` runs the same comparison on a real 12+ month
> \`timestamp,price\` series and labels it as such.

## Inputs

| | |
| --- | --- |
| History | ${source} |
| Series SHA-256 | \`${seriesDigest}\` |
| Configuration SHA-256 | \`${configDigest}\` |
| Inputs SHA-256 | \`${inputsDigest}\` |
| Arm start | ${money(START_PORTFOLIO.volatileUsd)} wNEAR, ${money(START_PORTFOLIO.reserveUsd)} reserve, ${money(START_PORTFOLIO.cashUsd)} operating cash |
| Profile | balanced (40/35/25, trim 20/30/45, DCA −20/−30/−40, halt −50, 2% order / 10% turnover) |
| Spend terms | ${money(monthly)} a month, 6 months protected: a ${money(floorUsd)} cash floor |
| Projection | ${RISK.projection.paths} paths, ${RISK.projection.horizonDays}-day horizon, ${RISK.projection.lookbackDays}-day lookback, seed ${RISK.projection.seed} |
| Risk thresholds | balanced profile defaults (${RISK.thresholds.drawdownPct.l1}/${RISK.thresholds.drawdownPct.l2}/${RISK.thresholds.drawdownPct.l3}% drawdown steps) |

The projection's \`paths\` is 200 here, not the server's 500, so 300 days can be assessed every hour in a script; the
thresholds are the profile's own.

## The comparison

| Arm | First de-risk | First Ballast sell | Max drawdown | End value | Lowest stables | Lowest runway above the floor (months) | Hours at L1+ | Trades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

- **Proposal timing:** ${stabilized.firstDeRiskAt === null ? "the stabilization agent sized no de-risk sell at the profile's default thresholds"
  : `the stabilization agent's first de-risk sell is at ${iso(stabilized.firstDeRiskAt)} (day ${day(stabilized.firstDeRiskAt)}); Ballast's bands alone first sell at ${iso(ballast.firstBallastSellAt)} (day ${day(ballast.firstBallastSellAt)})`}.
  ${earlier ? "The stabilization agent de-risks earlier, as the issue asks." : "**This run does not show the stabilization agent de-risking earlier**; the report says so rather than smoothing it over."}
- **Drawdown:** ${stabilized.maxDrawdownPct < ballast.maxDrawdownPct ? `the stabilization arm's deepest fall is ${pct(ballast.maxDrawdownPct - stabilized.maxDrawdownPct)} smaller` : "the stabilization arm's deepest fall is no smaller"}. Its end value is ${stabilized.finalValueUsd < ballast.finalValueUsd ? `${money(ballast.finalValueUsd - stabilized.finalValueUsd)} lower, because it sold before the recovery` : "higher"}: the protection costs upside, which is the trade it makes.
- **Runway and the cash floor:** ${aboveFloor ? `both arms keep the stables above the ${money(floorUsd)} floor for every hour; the lowest stables are ${money(ballast.minStableUsd)} alone and ${money(stabilized.minStableUsd)} with the agent` : "**at least one arm's stables fall under the floor**"}. Runway is the stables at plan spend, measured each hour; the replay harness doesn't model spending flows, so this is the balance's runway, not a cash-flow forecast.
- **How to read the assumption:** every de-risk is a proposal the owner signs. The backtest assumes the owner approves each one, which is what lets the swaps fill; the audit trail makes the same assessment replayable whether or not the owner did.

## What it does not show

- **Real history:** A8.2/H5 load it; until then this is a placeholder, and the thresholds are \`RISK_PROFILE_DEFAULTS\`, not calibrated values.
- **A depeg, a venue outage or an oracle outage:** the scenarios are assessed and recorded each hour, but this two-asset series has one volatile asset and no stablecoin price of its own, so their effect on the treasury isn't simulated here.
- **Spending:** no payouts are made; the spend rate only sets the floor and the runway.
- **A freeze:** the agent only ever recommends one. There is no freeze without the owner's signature (#95), and the backtest has no owner.
`;
}

/** Writes the report, and says where. `csv` is a real hourly series; without it the synthetic placeholder is run. */
export function writeReport({ out, csv }: { out: string; csv?: string }): string {
  let data: { warmup: Sample[]; series: Sample[] }, source: string;
  if (csv) {
    const text = readFileSync(csv, "utf8");
    const loaded = parseHistory(text);
    if (!loaded.ok) throw new Error(`${csv}: ${loaded.problems.join("; ")}`);
    data = { warmup: loaded.samples.slice(0, WARMUP_DAYS * 24), series: loaded.samples.slice(WARMUP_DAYS * 24) };
    source = `real hourly series \`${csv}\`, ${loaded.samples.length} samples (SHA-256 \`${sha256Hex(text)}\`)`;
  } else {
    data = syntheticPlaceholder();
    source = `deterministic synthetic placeholder: a seed-220 walk, 50% down over six hours at day ${CRASH_DAY}, a month at the low, two months back up`;
  }
  const report = reportFor(data, source);
  writeFileSync(out, report);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (mode !== "run") {
    console.error("usage: node scripts/stabilization-backtest.ts run [--csv <file>] [--out <path>]");
    process.exit(2);
  }
  const csv = value("--csv"), out = value("--out") ?? "docs/stabilization-backtest.md";
  console.log(`wrote ${writeReport({ out, ...(csv && { csv }) })}`);
}
