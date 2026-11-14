// The stabilization agent's pure logic (#220): the forward projection and the stress scenarios turned into an early
// warning (detections with a level, beside A6's) and into stabilization actions, each carrying the projection that
// justified it. It only ever recommends or proposes: a de-risk sell is sized inside ORDER_SIZE, the daily turnover and
// the volatile floor, then goes through the whole policy at the higher of the forward level and the rest of the
// system's, so it can't pass what the policy refuses; pausing autopilot and freezing are the owner's to do, and a freeze
// only takes effect once the owner signs it (the platform has no freeze without a signature: A14, #95). Every assessment
// is recorded with its inputs, and `replayRiskRecords` makes it again from them (A7.2). The thresholds are the mandate
// profile's (ADR 3 style, `RISK_PROFILE_DEFAULTS`), which a deployment may replace whole.

import type { Intent } from "./bands.ts";
import { checkPolicy, type FullContext, type PolicyConfig } from "./check.ts";
import { canonicalJson } from "./digest.ts";
import { isLevel, type Level } from "./levels.ts";
import { centsDown, legsFor, type LegsResult } from "./legs.ts";
import type { ProfileName } from "./mandate.ts";
import { orderCapUsd, type PolicyResult } from "./policy.ts";
import { CONSERVATIVE_PROJECTION, project, type Projection, type ProjectionParams } from "./projection.ts";
import { stressAll, type Book, type ScenarioParams, type SpendTerms, type StressResult } from "./scenarios.ts";
import type { WeightBounds } from "./sizing.ts";
import type { Sample } from "./smoothing.ts";
import { guarded, isNonNegative, isNum, isPct, report } from "./validate.ts";

/** A metric's thresholds for L1, L2 and L3, rising. */
export type RiskSteps = { l1: number; l2: number; l3: number };
/**
 * The early warning's thresholds: a mandate parameter, the profile's (`riskThresholdsOf`), as the bounds and limits are.
 * Each projected metric at or past a step raises that level; fewer months to the floor than a step raises it too.
 */
export type RiskThresholds = {
  drawdownPct: RiskSteps;
  shortfallPct: RiskSteps;
  breachProbabilityPct: RiskSteps;
  /** Months until the stables reach the floor at plan spend: under `l1` is L1, under `l2` L2. */
  monthsToFloor: { l1: number; l2: number };
  /** An expected shortfall at or past this, or a breach probability at its L3 step, recommends a freeze. */
  freezeShortfallPct: number;
  /** A de-risk sell aims to bring the projected drawdown back to this. */
  targetDrawdownPct: number;
};

/**
 * Profile defaults. Each profile's drawdown and shortfall steps scale with its volatile weight (20 / 40 / 60%), so the
 * same market raises the same level whatever the profile; the breach and runway steps are the same for all three. They
 * were checked only against the seeded backtest (docs/stabilization-backtest.md): real history is H5's (A8.2), and these
 * are placeholders until a backtest on it calibrates them, as H9 did the detectors.
 */
export const RISK_PROFILE_DEFAULTS: Readonly<Record<ProfileName, RiskThresholds>> = {
  conservative: {
    drawdownPct: { l1: 6, l2: 8, l3: 12 }, shortfallPct: { l1: 6, l2: 8, l3: 12 }, breachProbabilityPct: { l1: 1, l2: 5, l3: 20 },
    monthsToFloor: { l1: 3, l2: 1 }, freezeShortfallPct: 15, targetDrawdownPct: 5,
  },
  balanced: {
    drawdownPct: { l1: 12, l2: 16, l3: 24 }, shortfallPct: { l1: 12, l2: 16, l3: 24 }, breachProbabilityPct: { l1: 1, l2: 5, l3: 20 },
    monthsToFloor: { l1: 3, l2: 1 }, freezeShortfallPct: 30, targetDrawdownPct: 10,
  },
  growth: {
    drawdownPct: { l1: 18, l2: 24, l3: 36 }, shortfallPct: { l1: 18, l2: 24, l3: 36 }, breachProbabilityPct: { l1: 1, l2: 5, l3: 20 },
    monthsToFloor: { l1: 3, l2: 1 }, freezeShortfallPct: 45, targetDrawdownPct: 15,
  },
};

/** A mandate's risk thresholds: the deployment's, when it sets them, else its profile's, which no answer changes. */
export const riskThresholdsOf = (mandate: { profile: ProfileName }, override?: RiskThresholds): RiskThresholds =>
  override ?? RISK_PROFILE_DEFAULTS[mandate.profile];

/** What is wrong with the thresholds, if anything. */
export function riskThresholdProblems(t: RiskThresholds): string[] {
  return guarded(() => {
    const r = report();
    const rising = (s: RiskSteps) => isPct(s.l1) && isPct(s.l2) && isPct(s.l3) && s.l1 <= s.l2 && s.l2 <= s.l3;
    // The drawdown steps are checked once, and the target against them only when they are readable: a broken drawdown
    // set shouldn't also report the target it can't be compared with.
    const drawdownOk = rising(t.drawdownPct);
    r.need(drawdownOk, "drawdownPct steps must be percents above 0, rising");
    r.need(rising(t.shortfallPct), "shortfallPct steps must be percents above 0, rising");
    r.need(rising(t.breachProbabilityPct), "breachProbabilityPct steps must be percents above 0, rising");
    r.need(isNonNegative(t.monthsToFloor.l1) && isNonNegative(t.monthsToFloor.l2) && t.monthsToFloor.l1 >= t.monthsToFloor.l2, "monthsToFloor steps must be zero or more, l1 at least l2");
    r.need(isPct(t.freezeShortfallPct), "freezeShortfallPct must be a percent above 0");
    r.need(isPct(t.targetDrawdownPct) && (!drawdownOk || t.targetDrawdownPct < t.drawdownPct.l2), "targetDrawdownPct must be a percent under the drawdown's L2 step");
    return r.problems;
  });
}

export type RiskDetector = "risk-config" | "projection" | "projected-drawdown" | "expected-shortfall" | "floor-breach-probability" | "runway" | "stress";
/** A forward-risk detection, shaped as A6's are, so it joins their level and regime (`highestLevel`, `regimeFrom`). */
export type RiskDetection = { detector: RiskDetector; level: Level; reason: string };

/**
 * The early warning from a projection and the stress scenarios. Values exactly at a step count. A projection that
 * couldn't be made is L1, as a history too short to judge is for the market detectors: Ballast holds, and nothing is
 * sized on numbers that aren't there. A scenario that leaves the stables under the cash floor is L1: buys hold while one
 * plausible shock (a depeg, an outage, spend over plan) would breach it.
 */
export function detectForwardRisk(p: Projection, scenarios: readonly StressResult[], t: RiskThresholds): RiskDetection[] {
  const bad = riskThresholdProblems(t);
  if (bad.length > 0) return [{ detector: "risk-config", level: 1, reason: `invalid risk thresholds: ${bad.join("; ")}` }];
  const found: RiskDetection[] = [];
  if (!p.usable) found.push({ detector: "projection", level: 1, reason: `risk can't be projected: ${p.reasons.join("; ")}` });
  else {
    const step = (detector: RiskDetector, value: number, s: RiskSteps, what: string) => {
      const level: Level = value >= s.l3 ? 3 : value >= s.l2 ? 2 : value >= s.l1 ? 1 : 0;
      if (level > 0) found.push({ detector, level, reason: `${what} ${value.toFixed(1)}% is at or past its L${level} step, ${s[`l${level as 1 | 2 | 3}`]}%` });
    };
    step("projected-drawdown", p.projectedDrawdownPct, t.drawdownPct, "projected drawdown");
    step("expected-shortfall", p.expectedShortfallPct, t.shortfallPct, "expected shortfall");
    step("floor-breach-probability", p.breachProbabilityPct, t.breachProbabilityPct, "probability of breaching the cash floor");
    const months = `the stables reach the cash floor in ${p.monthsToFloor.toFixed(1)} months at plan spend`;
    if (p.monthsToFloor < t.monthsToFloor.l2) found.push({ detector: "runway", level: 2, reason: `${months}, under ${t.monthsToFloor.l2}` });
    else if (p.monthsToFloor < t.monthsToFloor.l1) found.push({ detector: "runway", level: 1, reason: `${months}, under ${t.monthsToFloor.l1}` });
  }
  const breached = scenarios.filter(s => s.floorBreached);
  if (breached.length > 0) found.push({ detector: "stress", level: 1,
    reason: `${breached.length === 1 ? "one scenario leaves" : `${breached.length} scenarios leave`} the stables under the cash floor: ${breached.slice(0, 3).map(s => s.label).join("; ")}` });
  return found;
}

/** What a de-risk sell needs beyond the book: the policy's context and config, the bounds, and the swap's pricing. */
export type RiskTrade = {
  /** As Ballast's own decision has them (`ballast.ts`): the rolling day's proposed turnover and the last hour's orders. */
  turnoverTodayUsd: number; ordersLastHour: number; quotedSlippageBps: number | null;
  /** Operating cash, for the cash-floor rule (a sell uses none of it: it adds to the reserve). */
  cashUsd: number;
  config: PolicyConfig;
  bounds: WeightBounds;
  /**
   * The level the rest of the system is at: the mandate's start level and the market detectors'. The policy checks the
   * sell at the higher of it and the forward level, so a de-risk never runs under a lower bar than Ballast's trades.
   */
  baseLevel: Level;
  /** When a trade was last proposed for the agent, by Ballast or by this agent, and the cooldown after it. */
  lastActionAt: number | null;
  cooldownMs: number;
  /** The proposal's prices and decimals by asset and its slippage bound; without them (a backtest) the sell has no legs. */
  pricing?: { prices: Readonly<Record<string, string>>; decimals: Readonly<Record<string, number>>; maxSlippageBps: number };
};

/** Everything an assessment is made from: what the audit log records, and what a replay makes it again from. */
export type RiskInput = {
  at: number;
  book: Book;
  terms: SpendTerms;
  /** Each volatile asset's hourly prices over the projection's lookback, by the book's asset. */
  history: Readonly<Record<string, readonly Sample[]>>;
  thresholds: RiskThresholds;
  projection: ProjectionParams;
  scenarios: ScenarioParams;
  /** Whether autopilot is on (null when unknown): pausing it is recommended only when it is. */
  autopilotOn: boolean | null;
  trade: RiskTrade;
};

/** The figures a recommendation was made on. */
export type RiskBasis = Pick<Projection, "projectedDrawdownPct" | "expectedShortfallPct" | "breachProbabilityPct" | "runwayMonths" | "monthsToFloor">
  & { level: Level; worstScenario: { id: string; drawdownPct: number; floorBreached: boolean } | null };

export type Recommendation =
  | { action: "hold-buys"; reason: string; basis: RiskBasis }
  | { action: "de-risk"; asset: string; into: string; sizeUsd: number; reason: string; basis: RiskBasis;
    /** Why it isn't proposed now, when it isn't: the policy refused it, a cooldown, or nothing left within the limits. */
    blocked: string | null }
  | { action: "pause-autopilot"; reason: string; basis: RiskBasis }
  | { action: "recommend-freeze"; reason: string; basis: RiskBasis };

export type RiskAssessment = {
  /** The forward level: the highest detection's (0 when none). */
  level: Level;
  detections: RiskDetection[];
  projection: Projection;
  /** Every scenario, most severe first. */
  scenarios: StressResult[];
  recommendations: Recommendation[];
  /**
   * The de-risk sell as the policy judged it, when one was sized; `proposal` is set when it passed (or needs approval),
   * no cooldown holds it and it has legs: that is what the server proposes, for the owner to approve.
   */
  derisk: { intent: Intent; policy: PolicyResult; proposal: { sizeUsd: string; legs: LegsResult } | null } | null;
};

/** A value as it reads back from the log, as `decide` takes its inputs. */
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const levelOf = (found: readonly { level: Level }[]): Level => found.reduce<Level>((top, d) => (d.level > top ? d.level : top), 0);
const usdText = (n: number) => `${Math.round(n).toLocaleString("en-US")} USD`;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The de-risk sell's size: toward the target drawdown, within one order, the day's turnover left and the volatile floor. */
function deriskSize(book: Book, p: Projection, t: RiskThresholds, trade: RiskTrade): { asset: string; into: string; sizeUsd: number; limit: string; orderCap: boolean } | null {
  const byValue = (a: Book[number], b: Book[number]) => b.usd - a.usd || (a.asset < b.asset ? -1 : 1);
  // With the swap's pricing, only an asset it can price and size is sold or bought: a multi-asset book (#221) may hold
  // one the platform can't swap, and the sell would never have legs. A book without pricing is sized as before.
  const priced = (h: Book[number]) => trade.pricing === undefined || (Object.hasOwn(trade.pricing.prices, h.asset) && Object.hasOwn(trade.pricing.decimals, h.asset));
  const volatile = book.filter(h => h.class === "volatile" && h.usd > 0 && priced(h)).sort(byValue);
  const stable = book.filter(h => h.class === "stable" && priced(h)).sort(byValue);
  const sold = volatile[0], into = stable[0];
  if (!sold || !into) return null;
  const total = book.reduce((sum, h) => sum + h.usd, 0), volatileUsd = book.filter(h => h.class === "volatile").reduce((sum, h) => sum + h.usd, 0);
  const limits = trade.config.limits;
  const candidates: [number, string][] = [
    // A drawdown scales with the volatile holding, so selling this share of it brings the projection to the target.
    [p.projectedDrawdownPct > t.targetDrawdownPct ? volatileUsd * (1 - t.targetDrawdownPct / p.projectedDrawdownPct) : Infinity, "the target drawdown"],
    [orderCapUsd(total, limits.maxOrderPctOfTreasury), `one order (${limits.maxOrderPctOfTreasury}% of the treasury)`],
    [limits.maxDailyTurnoverPct * total / 100 - trade.turnoverTodayUsd, `the day's turnover left (${limits.maxDailyTurnoverPct}% a day)`],
    [volatileUsd - trade.bounds.volatileMinPct * total / 100, `the volatile floor (${trade.bounds.volatileMinPct}%)`],
    [sold.usd, `the ${sold.symbol ?? sold.asset} held`],
  ];
  const orderCap = candidates[1]!;
  const bound = candidates.reduce((min, c) => (c[0] < min[0] ? c : min));
  return { asset: sold.asset, into: into.asset, sizeUsd: Math.max(0, bound[0]), limit: bound[1], orderCap: bound === orderCap };
}

/** `deriskSize`, failing closed: a book or limits it can't read size nothing. */
function guardedSize(...args: Parameters<typeof deriskSize>) {
  try {
    const sized = deriskSize(...args);
    return sized && Number.isFinite(sized.sizeUsd) ? sized : null;
  } catch { return null; }
}

/** What is wrong with the parts of an input the assessment reads directly (the engines check the rest). */
function inputProblems(input: unknown): string[] {
  if (!isRecord(input)) return ["the assessment's input must be an object"];
  const r = report();
  r.need(isNum(input.at), "at must be a time");
  r.need(input.autopilotOn === true || input.autopilotOn === false || input.autopilotOn === null, "autopilotOn must be true, false or null");
  const trade = input.trade;
  r.need(isRecord(trade) && isRecord(trade.config) && isRecord(trade.config.limits) && isRecord(trade.bounds), "trade must hold the policy's config and the bounds");
  if (isRecord(trade)) {
    r.need(isLevel(trade.baseLevel), "trade.baseLevel must be a level");
    r.need(trade.lastActionAt === null || isNum(trade.lastActionAt), "trade.lastActionAt must be a time or null");
    r.need(isNonNegative(trade.cooldownMs), "trade.cooldownMs must be zero or more");
  }
  return r.problems;
}

/**
 * One assessment: the projection and the scenarios, the forward detections and their level, and what the agent would do.
 * Inputs are taken in their stored form first, so a replay of the record sees exactly what this saw. An input it can't
 * read gives L1 and a hold on buys, with the reason, never an exception and never a trade.
 */
export function assessRisk(raw: RiskInput): RiskAssessment {
  const input = asStored(raw);
  const unreadable = inputProblems(input);
  if (unreadable.length > 0) {
    const projection: Projection = { usable: false, reasons: unreadable, ...CONSERVATIVE_PROJECTION };
    const detections: RiskDetection[] = [{ detector: "risk-config", level: 1, reason: `the assessment's input can't be read: ${unreadable.join("; ")}` }];
    const basis: RiskBasis = { ...pick(projection), level: 1, worstScenario: null };
    return asStored({ level: 1, detections, projection, scenarios: [], derisk: null,
      recommendations: [{ action: "hold-buys", basis, reason: `Ballast holds its trades, buys included: ${detections[0]!.reason}` }] });
  }
  const { at, book, terms, thresholds: t, trade } = input;
  const projection = project(book, terms, input.history, at, input.projection);
  const scenarios = stressAll(book, terms, input.scenarios);
  const detections = detectForwardRisk(projection, scenarios, t);
  const level = levelOf(detections);
  const worst = scenarios[0];
  const basis: RiskBasis = { ...pick(projection), level,
    worstScenario: worst ? { id: worst.id, drawdownPct: worst.drawdownPct, floorBreached: worst.floorBreached } : null };
  const why = detections.map(d => d.reason).join("; ");
  const recommendations: Recommendation[] = [];
  let derisk: RiskAssessment["derisk"] = null;
  const thresholdsOk = riskThresholdProblems(t).length === 0;
  // Holding buys is the cheapest action: at L1 Ballast's band trades wait (the forward detections join its regime).
  if (level >= 1) recommendations.push({ action: "hold-buys", basis, reason: `Ballast holds its trades, buys included, while forward risk is raised: ${why}` });

  // De-risking is sized only on a projection that could be made: never on the conservative stand-in.
  const sized = level >= 2 && projection.usable && thresholdsOk ? guardedSize(book, projection, t, trade) : null;
  if (sized) {
    const total = book.reduce((sum, h) => sum + h.usd, 0);
    const volatileUsd = book.filter(h => h.class === "volatile").reduce((sum, h) => sum + h.usd, 0);
    const policyLevel = Math.max(level, trade.baseLevel) as Level;
    const intent: Intent = { id: `risk-${at}`, zone: "hold", action: "sell-volatile", sizeUsd: sized.sizeUsd, dcaUnits: 0, at,
      reason: `de-risk: sell ${sized.sizeUsd.toFixed(2)} USD of ${sized.asset} into ${sized.into}, limited by ${sized.limit}` };
    const ctx: FullContext = { treasuryValueUsd: total, turnoverTodayUsd: trade.turnoverTodayUsd, ordersLastHour: trade.ordersLastHour,
      quotedSlippageBps: trade.quotedSlippageBps, venueExposureUsd: volatileUsd, cashUsd: trade.cashUsd, spendsCashUsd: 0, level: policyLevel };
    const cooling = trade.lastActionAt !== null && at - trade.lastActionAt < trade.cooldownMs;
    // Nothing left within a limit is refused as that limit would refuse it: the day's turnover, else the order cap.
    const policy: PolicyResult = sized.sizeUsd > 0 ? checkPolicy(intent, ctx, trade.config)
      : { ok: false, rule: sized.orderCap ? "ORDER_SIZE" : "DAILY_TURNOVER", detail: `nothing left within ${sized.limit}`,
        failed: [sized.orderCap ? "ORDER_SIZE" : "DAILY_TURNOVER"] };
    const cents = policy.ok !== false && !cooling ? centsDown(sized.sizeUsd) : undefined;
    const legs = cents !== undefined && trade.pricing
      ? legsFor({ decision: { action: "sell-volatile", sizeUsd: cents }, volatile: sized.asset, reserve: sized.into, ...trade.pricing }) : null;
    const blocked = policy.ok === false ? `the policy refuses it (${policy.rule}): ${policy.detail}`
      : cooling ? "a trade was proposed within the cooldown" : cents === undefined ? "under a cent" : legs && !legs.ok ? `no swap could be built (${legs.code})` : null;
    // A proposal needs legs that can be built: a failed `LegsResult` is never offered as one (the server would refuse it).
    derisk = { intent, policy, proposal: cents !== undefined && legs?.ok ? { sizeUsd: cents, legs } : null };
    const name = book.find(h => h.asset === sized.asset)?.symbol ?? sized.asset, intoName = book.find(h => h.asset === sized.into)?.symbol ?? sized.into;
    recommendations.push({ action: "de-risk", asset: sized.asset, into: sized.into, sizeUsd: Math.round(sized.sizeUsd * 100) / 100, basis, blocked,
      reason: `Sell ${usdText(sized.sizeUsd)} of ${name} into ${intoName} (limited by ${sized.limit}), proposed for your approval: ${why}` });
  }
  if (level >= 2 && input.autopilotOn === true)
    recommendations.push({ action: "pause-autopilot", basis, reason: `Autopilot rebalances to the saved targets on its own; pause it while forward risk is at L${level}: ${why}` });
  if (projection.usable && thresholdsOk && (projection.expectedShortfallPct >= t.freezeShortfallPct || projection.breachProbabilityPct >= t.breachProbabilityPct.l3))
    recommendations.push({ action: "recommend-freeze", basis,
      reason: `Expected shortfall ${projection.expectedShortfallPct.toFixed(1)}% and a ${projection.breachProbabilityPct.toFixed(1)}% chance of breaching the cash floor: `
        + "consider the emergency stop. It is only a recommendation: a freeze takes effect once you sign it, since the platform has no freeze that acts without a signature (#95)." });
  return asStored({ level, detections, projection, scenarios, recommendations, derisk });
}

const pick = (p: Projection) => ({ projectedDrawdownPct: p.projectedDrawdownPct, expectedShortfallPct: p.expectedShortfallPct,
  breachProbabilityPct: p.breachProbabilityPct, runwayMonths: p.runwayMonths, monthsToFloor: p.monthsToFloor });

/** An assessment as the audit log records it (`kind` is `chain.ts`'s `AUDIT_KINDS`). */
export type RiskRecord = { kind: "risk"; input: RiskInput; assessment: RiskAssessment };

/** What a replay compares: everything but the wording (`reason`, `reasons`, `label`), which may be reworded, as #208 did for intents. */
function decided(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decided);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "reason" && k !== "reasons" && k !== "label").map(([k, v]) => [k, decided(v)]));
}

export type RiskReplay = { ok: true; count: number } | { ok: false; index: number; seq?: number; recorded: unknown; replayed: unknown };

/** Makes every recorded assessment again from its inputs, and names the first that differs. A broken record differs. */
export function replayRiskRecords(records: readonly RiskRecord[], seqs?: readonly number[]): RiskReplay {
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const differs = (replayed: unknown): RiskReplay => ({ ok: false, index, ...(seqs?.[index] === undefined ? {} : { seq: seqs[index]! }), recorded: record?.assessment, replayed });
    let again: RiskAssessment;
    try { again = assessRisk(record.input); } catch (error) { return differs(`the assessment threw: ${String(error)}`); }
    if (canonicalJson(decided(again)) !== canonicalJson(decided(record.assessment))) return differs(again);
  }
  return { ok: true, count: records.length };
}

/** Replays every risk record in an audit log's text (its JSON lines), naming the first that differs by its sequence number. */
export function replayRiskLog(text: string): RiskReplay {
  const records: RiskRecord[] = [], seqs: number[] = [];
  for (const line of text.split("\n")) {
    let parsed: { seq?: unknown; entry?: { kind?: unknown } };
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.entry?.kind === "risk") { records.push(parsed.entry as RiskRecord); seqs.push(typeof parsed.seq === "number" ? parsed.seq : NaN); }
  }
  return replayRiskRecords(records, seqs);
}
