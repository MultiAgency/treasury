// Replay harness and simulated provider (A8.1): a price series run through readOracle → evaluateBands → checkPolicy,
// with a simulated portfolio and a provider that fills quotes with a modelled slippage. Deterministic: the only
// randomness is a seeded generator, so the same run twice gives the same trades. Fails closed like the real chain: a
// frozen oracle, a hold, a policy rejection or a needs-approval (no human in a replay) produce no trade. Every number
// is a named default awaiting H5/H6/H9.

import { evaluateBands, ENGINE_DEFAULTS, type EngineConfig } from "./engine.ts";
import { deviationPct, type Intent } from "./bands.ts";
import { DETECTOR_DEFAULTS, detectMarketMoves, type DetectorConfig } from "./detectors.ts";
import { regimeFrom } from "./faults.ts";
import { checkPolicy, POLICY_CONFIG_DEFAULTS, type FullContext, type PolicyConfig } from "./check.ts";
import type { Level } from "./levels.ts";
import { ORACLE_DEFAULTS, readOracle, SMOOTHING_DEFAULTS, type OracleLimits, type PriceQuote, type SmoothingLimits } from "./oracle.ts";
import type { Portfolio, WeightBounds } from "./sizing.ts";
import type { Sample } from "./smoothing.ts";
import { nextState, type Regime, type WhipsawState } from "./whipsaw.ts";
import { isNonNegative, isPositive, report } from "./validate.ts";

/** Seeded generator (mulberry32): a number in [0, 1). The same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PROVIDER_DEFAULTS = {
  /** Slippage every quote has, in basis points. */
  baseSlippageBps: 5,
  /** Plus up to this much more, drawn from the seeded generator. */
  jitterSlippageBps: 10,
} as const;

export type ProviderModel = { baseSlippageBps: number; jitterSlippageBps: number };

export function providerProblems(m: ProviderModel): string[] {
  const r = report();
  r.need(isNonNegative(m.baseSlippageBps), "baseSlippageBps must be zero or more");
  r.need(isNonNegative(m.jitterSlippageBps), "jitterSlippageBps must be zero or more");
  return r.problems;
}

export type Fill = {
  id: string;
  action: "buy-volatile" | "sell-volatile";
  sizeUsd: number;
  /** Mid price at the fill, and the price actually paid or received after slippage. */
  midPrice: number;
  fillPrice: number;
  slippageBps: number;
  /** Units of the volatile asset bought or sold. */
  quantity: number;
  at: number;
};
export type FillResult = { ok: true; fill: Fill } | { ok: false; reason: string };

/**
 * A simulated provider. It quotes slippage for an order, then fills that quote once: never twice for one id. The model
 * is optimistic: slippage comes from the same base-plus-jitter range (5–15 bps by default) whatever the order's size
 * (real slippage grows with size, so large orders fill better here than they would), and there are no fees.
 */
export class SimulatedProvider {
  private readonly random: () => number;
  private readonly model: ProviderModel;
  private readonly quoted = new Map<string, number>();
  private readonly filled = new Set<string>();
  constructor(seed: number, model: ProviderModel = PROVIDER_DEFAULTS) {
    this.model = model;
    this.random = seededRandom(seed);
  }

  /** Quoted slippage in basis points for an order id. Asking again for the same id returns the same quote. */
  quote(id: string): number | null {
    if (providerProblems(this.model).length > 0) return null;
    const seen = this.quoted.get(id);
    if (seen !== undefined) return seen;
    const bps = this.model.baseSlippageBps + this.random() * this.model.jitterSlippageBps;
    this.quoted.set(id, bps);
    return bps;
  }

  /** Fills the order at its quote. A second fill for the same id, or an order never quoted, is refused. */
  fill(order: Intent, midPrice: number): FillResult {
    if (order.action === "hold") return { ok: false, reason: "a hold is not an order" };
    if (this.filled.has(order.id)) return { ok: false, reason: `order ${order.id} was already filled` };
    const bps = this.quoted.get(order.id);
    if (bps === undefined) return { ok: false, reason: `order ${order.id} has no quote` };
    if (!(Number.isFinite(midPrice) && midPrice > 0) || !(Number.isFinite(order.sizeUsd) && order.sizeUsd > 0)) return { ok: false, reason: "unusable price or size" };
    this.filled.add(order.id);
    const buy = order.action === "buy-volatile";
    const fillPrice = midPrice * (buy ? 1 + bps / 10_000 : 1 - bps / 10_000);
    // A buy spends sizeUsd and gets sizeUsd / fillPrice units; a sell gives up sizeUsd of value at the mid price.
    const quantity = buy ? order.sizeUsd / fillPrice : order.sizeUsd / midPrice;
    return { ok: true, fill: { id: order.id, action: order.action, sizeUsd: order.sizeUsd, midPrice, fillPrice, slippageBps: bps, quantity, at: order.at } };
  }
}

export type ReplayConfig = {
  engine: EngineConfig;
  policy: PolicyConfig;
  oracle: OracleLimits;
  smoothing: SmoothingLimits;
  detectors: DetectorConfig;
  provider: ProviderModel;
  bounds: WeightBounds;
  /** The escalation level held throughout the replay. */
  level: Level;
  asset: string;
  /** Sources that quote the price; each gets the sample's price at the sample's time. */
  sources: readonly string[];
  /** An integer from 0 to 2^32 − 1. */
  seed: number;
};

/** The replay's own defaults. The spend rate is the user's, so it is unset here: set `policy.exposure.monthlySpendUsd`. */
export const REPLAY_DEFAULTS: ReplayConfig = {
  engine: ENGINE_DEFAULTS, policy: POLICY_CONFIG_DEFAULTS, oracle: ORACLE_DEFAULTS, smoothing: SMOOTHING_DEFAULTS,
  detectors: DETECTOR_DEFAULTS, provider: PROVIDER_DEFAULTS, bounds: { volatileMinPct: 10, volatileMaxPct: 70 }, level: 0, asset: "wNEAR",
  sources: ["a", "b", "c"], seed: 1,
};

export type StepOutcome = "traded" | "hold" | "frozen" | "rejected" | "needs-approval" | "fill-refused";
export type Step = { at: number; outcome: StepOutcome; detail: string; zone?: Intent["zone"]; rule?: string; frozenReason?: string };
/** Whole-treasury value after a step, for drawdown. */
export type EquityPoint = { at: number; valueUsd: number };

/** A run, or the problems that refused it before any step. */
export type ReplayResult = { ok: false; problems: string[] } | {
  ok: true;
  steps: Step[];
  trades: Fill[];
  /** Holdings after the last step (volatile valued at the last price). */
  portfolio: Portfolio;
  volatileQty: number;
  /** One point per sample, in order. */
  equity: EquityPoint[];
};

const DAY = 86_400_000, HOUR = 3_600_000;

/**
 * Replays `series` (oldest first). Each sample is a reading: the sources quote its price, the oracle checks them against
 * the history so far, the band engine gives an intent, the policy checks, and the provider fills what passes. The regime comes
 * from `regimeAt` (default: the market-move detectors over the history so far, including this sample). An invalid
 * configuration, or a starting volatile holding with no usable first price to value it, refuses the run. Returns every
 * step and the fills; nothing is stored between calls.
 */
export function replay(series: readonly Sample[], start: Portfolio, config: ReplayConfig = REPLAY_DEFAULTS,
  regimeAt: (at: number, history: readonly Sample[]) => Regime = (at, seen) => regimeFrom(detectMarketMoves(seen, at, config.detectors)),
  seedHistory: readonly Sample[] = []): ReplayResult {
  const first = series[0];
  const r = report();
  r.need(start.volatileUsd === 0 || isPositive(first?.price), "the first price must be above zero to value the starting volatile holding");
  const problems = [...replayProblems(config), ...r.problems];
  if (problems.length > 0) return { ok: false, problems };
  const provider = new SimulatedProvider(config.seed, config.provider);
  const steps: Step[] = [];
  const trades: Fill[] = [];
  // Seed samples sit before the series: they warm the EMA up but are not steps of the replay.
  const history: Sample[] = [...seedHistory];
  const equity: EquityPoint[] = [];
  let qty = first && start.volatileUsd !== 0 ? start.volatileUsd / first.price : 0;
  let reserve = start.reserveUsd;
  const cash = start.cashUsd;
  let state: WhipsawState = {};
  let dcaUnitsUsed = 0;
  let lastPrice = first?.price ?? 0;

  for (const sample of series) {
    const { at, price } = sample;
    lastPrice = price;
    const quotes: PriceQuote[] = config.sources.map(source => ({ source, asset: config.asset, price, observedAt: at }));
    const reading = readOracle(config.asset, quotes, history, at, config.oracle, config.smoothing);
    history.push(sample);
    const volatileUsd = qty * price;
    const portfolio: Portfolio = { volatileUsd, reserveUsd: reserve, cashUsd: cash };
    const intent = evaluateBands(reading, { portfolio, bounds: config.bounds, sizing: { dcaUnitsUsed }, whipsaw: state, regime: regimeAt(at, history) }, config.engine);
    const deviation = reading.frozen ? null : deviationPct(reading.twap15m, reading.ema30d);

    const record = (outcome: StepOutcome, detail: string, rule?: string) => {
      steps.push({ at, outcome, detail, zone: intent.zone, ...(rule ? { rule } : {}), ...(reading.frozen ? { frozenReason: reading.reason } : {}) });
    };
    const markEquity = () => equity.push({ at, valueUsd: qty * price + reserve + cash });
    if (reading.frozen) { record("frozen", `${reading.reason}: ${reading.detail}`); markEquity(); continue; }
    if (intent.action === "hold") { state = nextState(state, intent, deviation, at, config.engine.whipsaw, config.engine.bands); record("hold", intent.reason); markEquity(); continue; }

    const slippage = provider.quote(intent.id);
    const treasury = volatileUsd + reserve + cash;
    const dayAgo = at - DAY, hourAgo = at - HOUR;
    const recent = trades.filter(t => t.at > dayAgo);
    const ctx: FullContext = {
      treasuryValueUsd: treasury,
      turnoverTodayUsd: recent.reduce((sum, t) => sum + t.sizeUsd, 0),
      ordersLastHour: trades.filter(t => t.at > hourAgo).length,
      quotedSlippageBps: slippage,
      venueExposureUsd: volatileUsd,
      cashUsd: cash,
      spendsCashUsd: 0,
      level: config.level,
    };
    const verdict = checkPolicy(intent, ctx, config.policy);
    if (verdict.ok === false) { record("rejected", verdict.detail, verdict.rule); markEquity(); continue; }
    if (verdict.ok === "needs-approval") { record("needs-approval", verdict.reason); markEquity(); continue; }

    const result = provider.fill(intent, price);
    if (!result.ok) { record("fill-refused", result.reason); markEquity(); continue; }
    const fill = result.fill;
    trades.push(fill);
    if (fill.action === "buy-volatile") { reserve -= fill.sizeUsd; qty += fill.quantity; dcaUnitsUsed += intent.dcaUnits; }
    else { reserve += fill.quantity * fill.fillPrice; qty -= fill.quantity; }
    state = nextState(state, intent, deviation, at, config.engine.whipsaw, config.engine.bands);
    record("traded", `${fill.action} ${fill.sizeUsd.toFixed(2)} USD at ${fill.fillPrice.toFixed(4)}`);
    markEquity();
  }
  return { ok: true, steps, trades, portfolio: { volatileUsd: qty * lastPrice, reserveUsd: reserve, cashUsd: cash }, volatileQty: qty, equity };
}

/** What is wrong with the replay configuration, beyond what each engine checks for itself. */
export function replayProblems(c: ReplayConfig): string[] {
  const r = report();
  r.need(c.sources.length > 0 && c.asset.length > 0, "a replay needs an asset and at least one source");
  r.need(Number.isInteger(c.seed) && c.seed >= 0 && c.seed < 2 ** 32, "seed must be an integer from 0 to 2^32 − 1");
  return [...r.problems, ...providerProblems(c.provider)];
}
