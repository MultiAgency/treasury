// The replay harness for the diversified book (#221): `replay`'s loop with several volatile sleeves sharing one reserve
// and one cash floor. Each sample is one instant for every sleeve: each asset's sources quote it, each oracle reads its
// own history, each sleeve is decided by `evaluateSleeves`, and every trade goes through the policy and the book's venue
// and class caps (`checkBookExposure`) before the simulated provider fills it. Deterministic, like `replay`.
//
// A book of one sleeve at the profile's weight and bounds, with the account capped at the profile's ceiling, makes the
// trades `replay` makes on the same series: the test and the backtest (`scripts/diversify.ts`) both hold it to that.

import { deviationPct } from "./bands.ts";
import { checkPolicy, type FullContext } from "./check.ts";
import { canonicalJson, sha256Hex } from "./digest.ts";
import { detectMarketMoves } from "./detectors.ts";
import { maxDrawdownPct } from "./calibration.ts";
import { bookContext, checkBookExposure, combineResults, type BookExposureLimits, type BookHolding } from "./exposure.ts";
import { regimeFrom } from "./faults.ts";
import { readOracle, type PriceQuote } from "./oracle.ts";
import { replayProblems, SimulatedProvider, type EquityPoint, type Fill, type ReplayConfig, type StepOutcome } from "./replay.ts";
import { evaluateSleeves, sleeveProblems, type SleeveState, type SleeveTerms } from "./sleeves.ts";
import type { Sample } from "./smoothing.ts";
import { nextState, type Regime } from "./whipsaw.ts";
import { ASSET_REGISTRY, type AssetEntry } from "./assets.ts";
import { isNonNegative, report } from "./validate.ts";

const DAY = 86_400_000, HOUR = 3_600_000;

/** `replay`'s configuration, with the sleeves in place of its one asset and bounds, and the book's caps. */
export type BookReplayConfig = Omit<ReplayConfig, "asset" | "bounds"> & BookExposureLimits & { sleeves: SleeveTerms[]; volatileMaxPct: number };
export type BookStart = { volatileUsd: Readonly<Record<string, number>>; reserveUsd: number; cashUsd: number };
export type BookStep = { at: number; asset: string; outcome: StepOutcome; detail: string; rule?: string };
export type BookFill = Fill & { asset: string };

export type BookReplayResult = { ok: false; problems: string[] } | {
  ok: true;
  steps: BookStep[];
  trades: BookFill[];
  /** Units held of each sleeve's asset after the last step, and the reserve and cash. */
  quantities: Record<string, number>;
  reserveUsd: number;
  cashUsd: number;
  equity: EquityPoint[];
};

/** What is wrong with the run before it starts: the replay's own checks, the sleeves, and series that share their instants. */
export function bookReplayProblems(series: Readonly<Record<string, readonly Sample[]>>, start: BookStart, config: BookReplayConfig,
  registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): string[] {
  const r = report();
  for (const p of [...replayProblems({ ...config, asset: "book", bounds: { volatileMinPct: 0, volatileMaxPct: config.volatileMaxPct } }), ...sleeveProblems(config)]) r.need(false, p);
  r.need([start.reserveUsd, start.cashUsd, ...Object.values(start.volatileUsd)].every(isNonNegative), "every starting holding must be zero or more");
  const assets = config.sleeves.map(s => s.asset);
  const first = series[assets[0] ?? ""] ?? [];
  for (const asset of assets) {
    const s = series[asset];
    r.need(registry[asset] !== undefined, `${asset} isn't in the registry`);
    r.need(s !== undefined && s.length === first.length && s.every((x, i) => x.at === first[i]!.at), `${asset}'s series must have the same instants as ${assets[0]}'s`);
    r.need((start.volatileUsd[asset] ?? 0) === 0 || (s?.[0]?.price ?? 0) > 0, `${asset}: the first price must be above zero to value its starting holding`);
  }
  return r.problems;
}

/**
 * Replays the book over `series` (one per sleeve, at the same instants, oldest first). Each sleeve keeps its own oracle
 * history, regime (its own market moves), anti-whipsaw state and DCA units. Per instant, sleeves trade sells first, as
 * `evaluateSleeves` orders them, each checked against the book as it stands after the trades before it.
 */
export function replayBook(series: Readonly<Record<string, readonly Sample[]>>, start: BookStart, config: BookReplayConfig,
  seedHistory: Readonly<Record<string, readonly Sample[]>> = {}, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): BookReplayResult {
  const problems = bookReplayProblems(series, start, config, registry);
  if (problems.length > 0) return { ok: false, problems };
  const assets = config.sleeves.map(s => s.asset);
  const provider = new SimulatedProvider(config.seed, config.provider);
  const steps: BookStep[] = [], trades: BookFill[] = [], equity: EquityPoint[] = [];
  const history: Record<string, Sample[]> = Object.fromEntries(assets.map(a => [a, [...(seedHistory[a] ?? [])]]));
  const qty: Record<string, number> = Object.fromEntries(assets.map(a => [a, (start.volatileUsd[a] ?? 0) === 0 ? 0 : start.volatileUsd[a]! / series[a]![0]!.price]));
  const states: Record<string, SleeveState> = Object.fromEntries(assets.map(a => [a, { dcaUnitsUsed: 0, whipsaw: {} }]));
  let reserve = start.reserveUsd;
  const cash = start.cashUsd;
  const n = series[assets[0]!]!.length;

  for (let i = 0; i < n; i++) {
    const at = series[assets[0]!]![i]!.at;
    const price: Record<string, number> = Object.fromEntries(assets.map(a => [a, series[a]![i]!.price]));
    const readings = Object.fromEntries(assets.map(a => {
      const quotes: PriceQuote[] = config.sources.map(source => ({ source, asset: a, price: price[a]!, observedAt: at }));
      const reading = readOracle(a, quotes, history[a]!, at, config.oracle, config.smoothing);
      history[a]!.push({ at, price: price[a]! });
      return [a, reading];
    }));
    const regimes: Record<string, Regime> = Object.fromEntries(assets.map(a => [a, regimeFrom(detectMarketMoves(history[a]!, at, config.detectors))]));
    const usd = (a: string) => qty[a]! * price[a]!;
    const decided = evaluateSleeves(readings, { volatileUsd: Object.fromEntries(assets.map(a => [a, usd(a)])), reserveUsd: reserve, cashUsd: cash },
      config, states, regimes, config.engine);

    for (const { asset, intent: raw, config: engine } of decided) {
      const reading = readings[asset]!;
      // One id per sleeve and instant: the provider fills each id once.
      const intent = { ...raw, id: `${asset}-${raw.id}` };
      const record = (outcome: StepOutcome, detail: string, rule?: string) => steps.push({ at, asset, outcome, detail, ...(rule ? { rule } : {}) });
      const state = states[asset]!;
      if (reading.frozen) { record("frozen", `${reading.reason}: ${reading.detail}`); continue; }
      const deviation = deviationPct(reading.twap15m, reading.ema30d);
      if (intent.action === "hold") { state.whipsaw = nextState(state.whipsaw, intent, deviation, at, engine.whipsaw, engine.bands); record("hold", intent.reason); continue; }

      const slippage = provider.quote(intent.id);
      const riskUsd = assets.reduce((sum, a) => sum + usd(a), 0);
      const treasury = riskUsd + reserve + cash;
      const ctx: FullContext = {
        treasuryValueUsd: treasury,
        turnoverTodayUsd: trades.filter(t => t.at > at - DAY).reduce((sum, t) => sum + t.sizeUsd, 0),
        ordersLastHour: trades.filter(t => t.at > at - HOUR).length,
        quotedSlippageBps: slippage,
        // The account is one venue for every risk asset, as H6 counts it.
        venueExposureUsd: riskUsd, cashUsd: cash, spendsCashUsd: 0, level: config.level,
      };
      const holdings: BookHolding[] = [...assets.map(a => ({ asset: a, usd: usd(a) })), { asset: "USDC", usd: reserve + cash }];
      const book = bookContext(asset, holdings, treasury, registry);
      const verdict = book === null ? { ok: false as const, rule: "INVALID_INPUT" as const, detail: "the book can't be read", failed: ["INVALID_INPUT" as const] }
        : combineResults([checkPolicy(intent, ctx, config.policy), checkBookExposure(intent, book, config)]);
      if (verdict.ok === false) { record("rejected", verdict.detail, verdict.rule); continue; }
      if (verdict.ok === "needs-approval") { record("needs-approval", verdict.reason); continue; }

      const result = provider.fill(intent, price[asset]!);
      if (!result.ok) { record("fill-refused", result.reason); continue; }
      const fill = result.fill;
      trades.push({ ...fill, asset });
      if (fill.action === "buy-volatile") { reserve -= fill.sizeUsd; qty[asset]! += fill.quantity; state.dcaUnitsUsed += intent.dcaUnits; }
      else { reserve += fill.quantity * fill.fillPrice; qty[asset]! -= fill.quantity; }
      state.whipsaw = nextState(state.whipsaw, intent, deviation, at, engine.whipsaw, engine.bands);
      record("traded", `${fill.action} ${fill.sizeUsd.toFixed(2)} USD of ${asset} at ${fill.fillPrice.toFixed(4)}`);
    }
    equity.push({ at, valueUsd: assets.reduce((sum, a) => sum + usd(a), 0) + reserve + cash });
  }
  return { ok: true, steps, trades, quantities: qty, reserveUsd: reserve, cashUsd: cash, equity };
}

export type BookCalibrationInputs = {
  series: Readonly<Record<string, readonly Sample[]>>;
  seedHistory: Readonly<Record<string, readonly Sample[]>>;
  start: BookStart;
  config: BookReplayConfig;
};

export type BookCalibrationResult = { ok: false; problems: string[] } | {
  ok: true;
  /** SHA-256 of the inputs as canonical JSON: equal digests mean equal inputs. */
  inputDigest: string;
  outcomes: Record<StepOutcome, number>;
  rejectionsByRule: Record<string, number>;
  /** Every simulated fill, in order: what the trades summary counts, and what a venue cap can be checked against. */
  fills: BookFill[];
  trades: { count: number; buys: number; sells: number; tradedUsd: number; byAsset: Record<string, number> };
  maxDrawdownPct: number;
  startValueUsd: number;
  endValueUsd: number;
  /** The end value's lowest point, in USD: what the book was worth at its worst instant. */
  lowValueUsd: number;
  summary: string;
};

/** Replays the book and reports it as `calibrationReport` reports a single-asset run, with the trades per asset. */
export function bookCalibrationReport(inputs: BookCalibrationInputs): BookCalibrationResult {
  const result = replayBook(inputs.series, inputs.start, inputs.config, inputs.seedHistory);
  if (!result.ok) return result;
  const outcomes: Record<StepOutcome, number> = { traded: 0, hold: 0, frozen: 0, rejected: 0, "needs-approval": 0, "fill-refused": 0 };
  const rejectionsByRule: Record<string, number> = {};
  for (const s of result.steps) {
    outcomes[s.outcome]++;
    if (s.outcome === "rejected") rejectionsByRule[s.rule ?? "unknown"] = (rejectionsByRule[s.rule ?? "unknown"] ?? 0) + 1;
  }
  const buys = result.trades.filter(t => t.action === "buy-volatile").length;
  const byAsset: Record<string, number> = {};
  for (const t of result.trades) byAsset[t.asset] = (byAsset[t.asset] ?? 0) + 1;
  const trades = { count: result.trades.length, buys, sells: result.trades.length - buys, tradedUsd: result.trades.reduce((s, t) => s + t.sizeUsd, 0), byAsset };
  const startValueUsd = result.equity[0]?.valueUsd ?? 0, endValueUsd = result.equity[result.equity.length - 1]?.valueUsd ?? 0;
  const lowValueUsd = result.equity.reduce((low, p) => Math.min(low, p.valueUsd), Infinity);
  const drawdown = maxDrawdownPct(result.equity);
  const inputDigest = sha256Hex(canonicalJson(inputs));
  const summary = [
    `Book replay of ${result.equity.length} instants over ${Object.keys(inputs.series).join(", ")}, input ${inputDigest}.`,
    `Steps: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Rejections by rule: ${Object.keys(rejectionsByRule).length === 0 ? "none" : Object.entries(rejectionsByRule).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Trades: ${trades.count} (${buys} buys, ${trades.sells} sells; ${Object.entries(byAsset).map(([a, c]) => `${a} ${c}`).join(", ") || "none"}), ${trades.tradedUsd.toFixed(2)} USD traded.`,
    `Treasury value ${startValueUsd.toFixed(2)} to ${endValueUsd.toFixed(2)} USD, max drawdown ${drawdown.toFixed(2)}%.`,
  ].join("\n");
  return { ok: true, inputDigest, outcomes, rejectionsByRule, fills: result.trades, trades, maxDrawdownPct: drawdown, startValueUsd, endValueUsd, lowValueUsd, summary };
}
