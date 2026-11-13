import { PROPOSAL_TOKENS, type OwnerOutput } from "@multiagency/sdk";
import { z } from "zod";
import {
  assessRisk, ASSET_REGISTRY, assetById, assetBySymbol, bookContext, bookExposure, bookLimitProblems, checkQuotes, compileMandate, decide,
  detectFaults, detectMarketMoves, deviationPct, diversifiedProblems, ENGINE_DEFAULTS, evaluateSleeves,
  hedgeTermsProblems, HEDGE_DEFAULTS, highestFaultLevel, highestLevel, mandateFrameOf, nextState, policyConfigOf, PROFILE_DEFAULTS,
  proposable, PROPOSAL_ASSETS, readOracle, regimeFrom, riskThresholdsOf, runwayCash, rwaOn, sleeveBookOf, VENUE_IDS, VENUES,
  weightBoundsOf, type AssetEntry, type Book, type BookHoldings, type DecisionRecord, type DiversifiedTerms,
  type EngineConfig, type HedgeTerms, type Intent, type Level, type OracleReading, type ProfileName,
  type Recommendation, type Regime, type RiskAssessment, type RiskInput, type Sample, type SleeveState,
  type WhipsawState,
} from "../../../packages/core/src/index.ts";
import { createRecords } from "./records.ts";
import { newRequestId, type Body } from "./requests.ts";
import type { PriceFeeds } from "./prices.ts";
import { projectionOf, riskThresholdSettings, scenariosOf, type RiskEntry, type RiskSettings } from "./risk.ts";

/** The venue the two-asset risk book is held at, named as the owner reads it in a scenario ("NEAR Intents unavailable …"). */
const RISK_VENUE = VENUES[VENUE_IDS.intents]!.label;

/** A sleeve's own band thresholds, if the owner sets them; the engine's otherwise (H9, ADR 3). */
const bandsSettings = z.strictObject({
  trim: z.tuple([z.number(), z.number(), z.number()]),
  dca: z.tuple([z.number(), z.number(), z.number()]),
  buyHalt: z.number(),
});
/** A sleeve the owner configures: its registry symbol, its target, the bounds it may drift in, in percent of the book, and optional bands. */
const sleeveSettings = z.strictObject({
  asset: z.string().min(1).max(32),
  targetPct: z.number().positive().max(100),
  minPct: z.number().min(0).max(100),
  maxPct: z.number().min(0).max(100),
  bands: bandsSettings.optional(),
});
/** The owner's real-world-asset eligibility and the horizon within which one must redeem to count towards the cash floor. */
const rwaSettings = z.strictObject({
  eligible: z.boolean(), kycVerified: z.boolean(), maxPct: z.number().min(0).max(100), cashHorizonDays: z.number().min(0).max(365),
});
/**
 * The diversified book's terms (#221) as the watch file may set them: the sleeves, the classes the owner allows and
 * their caps, the caps per venue, how the reserve splits, and the real-world terms. The compiler fills what's left out
 * from the profile; `diversificationProblemsFor` checks the whole against the compiled mandate, so a sleeve or coin the
 * platform doesn't list is refused at load, never proposed.
 */
export const diversificationSettings = z.strictObject({
  sleeves: z.array(sleeveSettings).min(1),
  classes: z.array(z.enum(["volatile", "stable", "rwa"])).min(1).optional(),
  classCapsPct: z.partialRecord(z.enum(["volatile", "stable", "rwa"]), z.number()).optional(),
  venueCapsPct: z.record(z.string().min(1), z.number()).optional(),
  stableSplit: z.record(z.string().min(1), z.number()).optional(),
  rwa: rwaSettings.optional(),
});
export type DiversificationSettings = z.output<typeof diversificationSettings>;

/**
 * The hedge the owner's page plans (#221): the assets they want some exposure to besides the sleeves (gold, other chains'
 * majors), each with a target and a ceiling in percent of the treasury, and the limits a move is judged by. The class and
 * venue caps here are added to the mandate's, and a class with no cap isn't allowed: gold, a real-world asset, needs
 * `classCapsPct.rwa` set here. It is read by the page and the assistant; `watch` proposes nothing from it, and it is no
 * part of the mandate, so a mandate's digest is the same with or without it.
 */
export const hedgeSettings = z.strictObject({
  sleeves: z.array(z.strictObject({ asset: z.string().min(1).max(32), targetPct: z.number(), maxPct: z.number() })).min(1).max(8),
  maxMoveUsd: z.number().optional(),
  maxCostBps: z.number().optional(),
  maxQuoteAgeMs: z.number().optional(),
  hedgeAtLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  driftPoints: z.number().optional(),
  maxSourceSharePct: z.number().optional(),
  classCapsPct: z.partialRecord(z.enum(["volatile", "stable", "rwa"]), z.number()).optional(),
  venueCapsPct: z.record(z.string().min(1), z.number()).optional(),
}).superRefine((value, ctx) => {
  for (const problem of hedgeTermsProblems(hedgeTermsOf(value))) ctx.addIssue({ code: "custom", message: problem });
  for (const [cls, pct] of Object.entries(value.classCapsPct ?? {})) if (!(pct >= 0 && pct <= 100)) ctx.addIssue({ code: "custom", message: `the ${cls} class cap must be 0 to 100` });
  for (const problem of bookLimitProblems({ venueCapsPct: value.venueCapsPct ?? {}, classCapsPct: {} })) ctx.addIssue({ code: "custom", message: problem });
});
export type HedgeSettings = z.output<typeof hedgeSettings>;
/** The planner's terms from the hedge block: its limits over the defaults. */
export const hedgeTermsOf = (settings: HedgeSettings): HedgeTerms => ({
  ...HEDGE_DEFAULTS, sleeves: settings.sleeves,
  ...(settings.maxMoveUsd !== undefined && { maxMoveUsd: settings.maxMoveUsd }),
  ...(settings.maxCostBps !== undefined && { maxCostBps: settings.maxCostBps }),
  ...(settings.maxQuoteAgeMs !== undefined && { maxQuoteAgeMs: settings.maxQuoteAgeMs }),
  ...(settings.hedgeAtLevel !== undefined && { hedgeAtLevel: settings.hedgeAtLevel }),
  ...(settings.driftPoints !== undefined && { driftPoints: settings.driftPoints }),
  ...(settings.maxSourceSharePct !== undefined && { maxSourceSharePct: settings.maxSourceSharePct }),
});

/**
 * What the owner chose for an agent `watch` runs Ballast for (#47): a profile and the mandate answers the platform can't
 * read. The treasury's value comes from `overview` on every tick, so the mandate is compiled again each time and a
 * floor the cash share can no longer hold refuses, never proposes. With `diversification`, `watch` runs the multi-sleeve
 * book (#221) instead of the one-sleeve wNEAR/USDC one; without it, nothing changes.
 */
export const ballastSettings = z.strictObject({
  profile: z.enum(["conservative", "balanced", "growth"]),
  monthlySpendUsd: z.number().positive(),
  operatingCashMonths: z.number().positive().max(36),
  destinations: z.array(z.string().min(2)).min(1),
  approvers: z.array(z.string().min(2)).min(1),
  diversification: diversificationSettings.optional(),
  /** This mandate's own risk thresholds (#220); unset, its profile's (`RISK_PROFILE_DEFAULTS`), until a backtest calibrates them. */
  risk: riskThresholdSettings.optional(),
  /** The hedge the owner's page plans into gold and other chains' assets (#221); nothing proposes from it on its own. */
  hedge: hedgeSettings.optional(),
});
export type BallastSettings = z.output<typeof ballastSettings>;

/** H5 (ADR 3): wNEAR is the volatile asset, USDC the reserve and the operating cash. */
const VOLATILE = PROPOSAL_ASSETS.wNEAR, STABLE = PROPOSAL_ASSETS.USDC;
const WNEAR_SYMBOL = "wNEAR", USDC_SYMBOL = "USDC";

/** The mandate answers a config compiles from: the sleeves name the volatile assets, the split names the stablecoins. */
export function mandateAnswersOf(settings: BallastSettings, treasuryValueUsd: number): Record<string, unknown> {
  const terms = settings.diversification;
  return {
    monthlySpendUsd: settings.monthlySpendUsd, operatingCashMonths: settings.operatingCashMonths, treasuryValueUsd,
    destinations: settings.destinations, approvers: settings.approvers,
    volatileAssets: terms ? terms.sleeves.map(s => s.asset) : [WNEAR_SYMBOL],
    stablecoins: terms?.stableSplit ? Object.keys(terms.stableSplit) : [USDC_SYMBOL],
    ...(terms && { diversification: terms }),
  };
}

/**
 * A treasury that can hold the mandate's cash floor, for checking a config before any agent's book is read: the floor
 * divided by the profile's cash share. The real book is read on every tick and compiled again, as before.
 */
export function configTreasuryOf(settings: BallastSettings): number {
  const cashPct = PROFILE_DEFAULTS[settings.profile as ProfileName].weights.cashPct;
  // A dollar over the exact floor: checking a config mustn't fail on floating-point noise at the boundary.
  return Math.max(1, (settings.monthlySpendUsd * settings.operatingCashMonths * 100) / cashPct + 1);
}

/** What is wrong with an agent's diversification config against the mandate it compiles to, if anything (empty otherwise). */
export function diversificationProblemsFor(settings: BallastSettings): string[] {
  if (!settings.diversification) return [];
  const compiled = compileMandate(mandateAnswersOf(settings, configTreasuryOf(settings)), settings.profile as ProfileName);
  if (!compiled.ok) return compiled.problems;
  const terms = compiled.mandate.diversification;
  if (!terms) return ["the diversification block compiled to a mandate without terms"];
  return diversifiedProblems(terms, mandateFrameOf(compiled.mandate));
}
const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
/** History kept per asset: the EMA's 30-day warm-up, plus a margin. */
const HISTORY_MS = 35 * DAY_MS;
/** A proposal is kept for its turnover a day, and for its DCA units until it settles or could no longer execute (7 days). */
const PROPOSED_MS = 8 * DAY_MS;

/** Only thin liquidity lacks observable inputs here. */
const NOT_JUDGED_HERE = new Set(["thin-liquidity"]);

const sample = z.strictObject({ asset: z.string().min(1), at: z.number().int(), price: z.number().positive() });

/** Every reading this recent is kept, for the 15-minute TWAP; older ones are thinned to the first of each hour. */
const RECENT_MS = 2 * HOUR_MS;
const hourOf = (at: number) => Math.floor(at / HOUR_MS);

/** The first sample of each UTC hour, oldest first. */
function hourly(samples: readonly Sample[]): Sample[] {
  const seen = new Set<number>();
  return samples.filter(s => { const hour = hourOf(s.at); if (seen.has(hour)) return false; seen.add(hour); return true; });
}

/**
 * The oracle's medians per asset, kept for `HISTORY_MS` in an owner-only file: every reading of the last `RECENT_MS`, so
 * the TWAP averages real readings, and before that the first of each UTC hour, which is what the EMA, the detectors and
 * H9's calibration (which counts chop reversals per hourly sample) were built on.
 */
export async function createPriceHistory(path: string) {
  const { all, commit } = await createRecords(path, "samples", sample, "Ballast's price history");
  const of = (asset: string): Sample[] => all().filter(s => s.asset === asset).map(({ at, price }) => ({ at, price })).sort((a, b) => a.at - b.at);
  return {
    /** Every sample kept: what the oracle reads. */
    of,
    /** One sample an hour: what the market-move detectors read. */
    hourly: (asset: string): Sample[] => hourly(of(asset)),
    /** Keeps `price` at `at`, thins what has left the recent window, and drops what's older than the history. */
    record: (asset: string, at: number, price: number) => commit(current => {
      if (current.some(s => s.asset === asset && s.at >= at)) return null;
      const mine = [...current.filter(s => s.asset === asset), { asset, at, price }].sort((a, b) => a.at - b.at);
      const firsts = new Set(hourly(mine).map(s => s.at));
      const kept = mine.filter(s => s.at >= at - HISTORY_MS && (s.at >= at - RECENT_MS || firsts.has(s.at)));
      return [...current.filter(s => s.asset !== asset), ...kept];
    }).then(() => {}),
    /** Seeds an asset's history from earlier samples (`seed-history.ts`), keeping one an hour and any already held. */
    seed: (asset: string, samples: readonly Sample[], now: number) => commit(current => {
      const held = new Set(current.filter(s => s.asset === asset).map(s => hourOf(s.at)));
      const added: z.output<typeof sample>[] = [];
      for (const { at, price } of samples) {
        const hour = hourOf(at);
        if (at > now || at < now - HISTORY_MS || held.has(hour)) continue;
        held.add(hour);
        added.push({ asset, at, price });
      }
      return added.length ? [...current, ...added].sort((a, b) => a.at - b.at) : null;
    }).then(() => {}),
  };
}
export type PriceHistory = Awaited<ReturnType<typeof createPriceHistory>>;

const whipsawState = z.strictObject({
  lastActionAt: z.number().optional(),
  lastAction: z.enum(["buy-volatile", "sell-volatile"]).optional(),
  disarmed: z.enum(["trim-3", "trim-2", "trim-1", "hold", "dca-1", "dca-2", "dca-3", "buy-halt"]).optional(),
});
/** One sleeve's kept state (`SleeveState`): its DCA units and anti-whipsaw state. */
const sleeveState = z.strictObject({ dcaUnitsUsed: z.number().min(0), whipsaw: whipsawState });
/** A proposal Ballast made, with the anti-whipsaw state from before it (`whipsawBefore`), so one never stored can be undone. */
const proposed = z.strictObject({ requestId: z.string().min(1), at: z.number(), sizeUsd: z.number().positive(), dcaUnits: z.number().min(0), settled: z.boolean(),
  /** The sleeve (registry symbol) a diversified proposal belongs to; absent for the two-asset book, whose state is above. */
  asset: z.string().min(1).optional(), whipsawBefore: whipsawState.optional() });
const engineState = z.strictObject({
  organization: z.string().min(1), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** The two-asset book's state; a diversified agent's sleeves keep their own below and these stay unused. */
  whipsaw: whipsawState, dcaUnitsUsed: z.number().min(0), proposed: z.array(proposed),
  /** Each sleeve's own state (#221), by registry symbol. Absent in a state written before the multi-sleeve book. */
  sleeves: z.record(z.string(), sleeveState).optional(),
});
type EngineState = z.output<typeof engineState>;
const FRESH_SLEEVE: SleeveState = { dcaUnitsUsed: 0, whipsaw: {} };
const sleeveOf = (s: EngineState, asset: string): SleeveState => s.sleeves?.[asset] ?? FRESH_SLEEVE;

/**
 * The state as if proposal `p` had never been decided: its zone and cooldown as they were before it, and it no longer
 * counts towards turnover or the order rate. `watch` decides nothing else for the agent while it's live, so nothing
 * changed the state in between. One recorded before its state was kept (`whipsawBefore`) only stops counting.
 */
const undone = (s: EngineState, p: EngineState["proposed"][number]): EngineState => {
  const proposed = s.proposed.filter(x => x.requestId !== p.requestId);
  if (!p.asset) return { ...s, ...(p.whipsawBefore && { whipsaw: p.whipsawBefore }), proposed };
  const before = sleeveOf(s, p.asset);
  return { ...s, sleeves: { ...s.sleeves, [p.asset]: { ...before, ...(p.whipsawBefore && { whipsaw: p.whipsawBefore }) } }, proposed };
};

/**
 * Ballast's state per agent, kept across restarts: the anti-whipsaw state, the DCA units its executed buys spent, and
 * the proposals it made, for the policy's turnover and order counts. A proposal counts from when it's made, whether or
 * not it's approved: an over-count only holds back more.
 */
export async function createEngineState(path: string) {
  const { all, commit } = await createRecords(path, "agents", engineState, "Ballast's engine state");
  const find = (organization: string, agent: string): EngineState =>
    all().find(s => s.organization === organization && s.agent === agent) ?? { organization, agent, whipsaw: {}, dcaUnitsUsed: 0, proposed: [] };
  const change = (organization: string, agent: string, update: (state: EngineState) => EngineState | null) => commit(current => {
    const next = update(find(organization, agent));
    if (!next) return null;
    return [...current.filter(s => !(s.organization === organization && s.agent === agent)), next];
  }).then(() => {});
  return { find, change };
}
export type EngineStates = Awaited<ReturnType<typeof createEngineState>>;

/** A price as the decimal string `legsFor` takes. */
export const decimalOf = (price: number) => price.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");

type Holding = OwnerOutput<"overview">["book"][number];
/**
 * A Ballast decision as the audit log records it (A7.2, #54): the engines' record, the agent it was made for, and for
 * one that proposes, the `requestId` its request is stored and sent under (#172). A recorded `requestId` with no
 * request or proposal under it was never stored (the store was full, or the server stopped first).
 */
export type DecisionEntry = DecisionRecord & { organization: string; agent: string; requestId?: string };
/** What one tick decided: a proposal to make under its `requestId`, with what to record once it's stored, or why not. */
export type Decision =
  | { requestId: string; body: Body; intent: Intent; level: Level; /** The sleeve a diversified proposal belongs to. */ asset?: string; detail: Record<string, unknown>; risk?: RiskEvent }
  | { skipped: string; risk?: RiskEvent; [detail: string]: unknown };

/** What a tick's stabilization assessment found, for the watch event and the log line: its level, why, and its actions. */
export type RiskEvent = {
  /** The forward level, 0 to 4: the policy checks every trade at the higher of it and Ballast's own. */
  level: Level;
  reason: string;
  recommendations: Recommendation["action"][];
  derisk: { sizeUsd: number; blocked: string | null } | null;
};

/** The event a risk block adds to the tick: the level with its reasons, what the agent would do, and its de-risk size. */
export function riskEventOf(assessment: RiskAssessment): RiskEvent {
  const derisk = assessment.recommendations.find(r => r.action === "de-risk");
  return {
    level: assessment.level,
    reason: assessment.detections.length > 0
      ? assessment.detections.map(d => d.reason).join("; ")
      : "no forward risk detected: the projection and every stress scenario are within their steps",
    recommendations: assessment.recommendations.map(r => r.action),
    derisk: derisk?.action === "de-risk" ? { sizeUsd: derisk.sizeUsd, blocked: derisk.blocked } : null,
  };
}

/**
 * Ballast's step for `watch` (#47): the platform's price through the oracle, the band engine, the policy and `legsFor`,
 * to one swap proposal or a reason to hold. Every proposal is still the owner's to approve, so a level that asks for a
 * human (L2, L3 sells) proposes; one that refuses (L3 buys, L4) doesn't.
 *
 * The sleeves come from the book: wNEAR is volatile; USDC up to the mandate's cash floor is operating cash, and the rest
 * is the reserve the DCA draws on, so a buy never reaches into the floor. Slippage isn't quoted before proposing (app
 * access has no quote): it's bounded by the leg's `minAmountOut` at the mandate's limit, which the platform refuses if the
 * quote is worse, so the policy's own slippage rule is given 0 and thin liquidity isn't a detection here. Unresolved
 * operations already hold `watch` before this runs, so none are unknown here; `unreconciled` is how far the holdings are
 * off the platform's records (`reconcileBooks`, read by `watch`), null when unread, and over 0.1% of the book is L3.
 */
export function createBallast({ history, states, audit, prices: feeds, now = Date.now }: {
  history: PriceHistory; states: EngineStates;
  /** The oracle's three independent sources for each asset (H5): never the platform's own price. */
  prices: PriceFeeds;
  /** Where every decision and risk assessment is recorded with its inputs (A7.2, #54; #220): the server's hash-chained audit log. */
  audit: { append(entry: DecisionEntry | RiskEntry): Promise<void> };
  now?: () => number;
}) {
  const stablePrice = async (entry: AssetEntry, at: number) => {
    const checked = checkQuotes(entry.id!, await feeds.quotes(entry), at);
    return checked.frozen ? null : checked.median;
  };
  return {
    async decide(organization: string, agent: string, settings: BallastSettings, overview: OwnerOutput<"overview">, proposalHours: number,
      risk?: RiskSettings, autopilotOn: boolean | null = null, assessmentOnly = false, unreconciled: number | null = null): Promise<Decision> {
      const at = now();
      const row = (asset: string) => overview.book.find(h => h.asset === asset) as Holding | undefined;
      const volatile = row(VOLATILE), stable = row(STABLE);
      if (!volatile || !stable) return { skipped: "ballast needs wNEAR and USDC in the book", assets: overview.book.map(h => h.asset) };
      const unusable = (h: Holding) => h.usd === null || !(h.usd >= 0) || h.price === null || !(h.price > 0);
      if (unusable(volatile) || unusable(stable)) return { skipped: "unpriced", assets: [volatile, stable].filter(unusable).map(h => h.asset) };
      const total = overview.book.reduce((sum, h) => sum + (h.usd ?? Number.NaN), 0);
      if (!(total > 0)) return { skipped: "unpriced", detail: "a holding in the book has no value" };

      const mandate = compileMandate({ ...settings, treasuryValueUsd: total, volatileAssets: ["wNEAR"], stablecoins: ["USDC"] }, settings.profile as ProfileName);
      if (!mandate.ok) return { skipped: "mandate refused", problems: mandate.problems };
      const { mandate: m, cashFloorUsd } = mandate;

      // The oracle: this tick's three quotes checked alone first, so their median joins the history even while the EMA warms up.
      const quotes = await feeds.quotes(assetById(VOLATILE)!);
      const before = history.of(VOLATILE);
      const reading = readOracle(VOLATILE, quotes, before, at);
      const checked = checkQuotes(VOLATILE, quotes, at);
      if (!checked.frozen) await history.record(VOLATILE, at, checked.median);
      // The detectors read one sample an hour, as H9 calibrated them, plus this reading.
      const hourlySeen = hourly(before).concat(checked.frozen ? [] : [{ at, price: checked.median }]);

      const market = detectMarketMoves(hourlySeen, at);
      // Thin liquidity needs a quote this step doesn't have (see above): its input is given as unknown, and its detection
      // is the only one left out.
      const faults = detectFaults({
        oracleFrozen: reading.frozen ? reading.reason : null, quotedSlippageBps: null, venueUp: true,
        stablecoinPrices: { USDC: await stablePrice(assetById(STABLE)!, at) }, cashUsd: stable.usd, cashFloorUsd, unknownOutcomes: 0, bookUsd: total, unreconciledUsd: unreconciled,
      }).filter(d => !NOT_JUDGED_HERE.has(d.detector));
      const baseLevel = Math.max(highestLevel(market), highestFaultLevel(faults), m.governance.startLevel) as Level;
      const reserveUsd = Math.max(0, stable.usd! - cashFloorUsd), cashUsd = stable.usd! - reserveUsd;

      const state = states.find(organization, agent);
      const recent = state.proposed.filter(p => p.at > at - DAY_MS);
      const prices = { [VOLATILE]: decimalOf(volatile.price!), [STABLE]: decimalOf(stable.price!) };
      const decimals = Object.fromEntries(Object.entries(PROPOSAL_TOKENS).map(([asset, token]) => [asset, token.decimals]));
      const turnoverTodayUsd = recent.reduce((sum, p) => sum + p.sizeUsd, 0);
      const ordersLastHour = recent.filter(p => p.at > at - HOUR_MS).length;

      // The stabilization agent (#220), beside Ballast and on the same reads: the book, the mandate's spend terms, the
      // price history this tick already keeps, and the policy context a de-risk sell would be checked under. Its record
      // goes to the log with every input before anything acts on it, and a record that can't be appended stops the tick.
      let riskAssessment: RiskAssessment | undefined, riskInput: RiskInput | undefined;
      let riskIntent: Intent | undefined, riskRequestId: string | undefined;
      if (risk) {
        const projection = projectionOf(risk), scenarios = scenariosOf(risk);
        const book: Book = [
          { asset: VOLATILE, symbol: "wNEAR", class: "volatile", usd: volatile.usd!, venue: RISK_VENUE },
          { asset: STABLE, symbol: "USDC", class: "stable", usd: stable.usd!, venue: RISK_VENUE },
        ];
        // The projection draws on the lookback only; a max-gap margin keeps the first return readable.
        const from = at - projection.lookbackDays * DAY_MS - projection.maxGapMs;
        riskInput = {
          at, book,
          terms: { monthlySpendUsd: settings.monthlySpendUsd, operatingCashMonths: settings.operatingCashMonths },
          history: { [VOLATILE]: hourlySeen.filter(s => s.at >= from) },
          thresholds: riskThresholdsOf(m, settings.risk),
          projection, scenarios,
          autopilotOn: autopilotOn ?? null,
          trade: {
            turnoverTodayUsd, ordersLastHour, quotedSlippageBps: 0, cashUsd: stable.usd!, config: policyConfigOf(m), bounds: weightBoundsOf(m),
            baseLevel, lastActionAt: state.whipsaw.lastActionAt ?? null, cooldownMs: ENGINE_DEFAULTS.whipsaw.cooldownMs,
            pricing: { prices, decimals, maxSlippageBps: m.limits.policy.maxSlippageBps },
          },
        };
        riskAssessment = assessRisk(riskInput);
        // While autopilot runs nothing is proposed (two proposers would race), so a de-risk names no request.
        if (riskAssessment.derisk?.proposal && autopilotOn !== true && !assessmentOnly && faults.length === 0) { riskIntent = riskAssessment.derisk.intent; riskRequestId = newRequestId(agent); }
        await audit.append({ kind: "risk", organization, agent, input: riskInput, assessment: riskAssessment,
          ...(riskRequestId !== undefined && { requestId: riskRequestId }) });
      }
      if (assessmentOnly) return { skipped: "assessment only", ...(riskAssessment && { risk: riskEventOf(riskAssessment) }) };
      // While autopilot runs, Ballast decides nothing: the risk agent has assessed it and recommended pausing it if needed.
      if (autopilotOn === true) return { skipped: "autopilot", ...(riskAssessment && { risk: riskEventOf(riskAssessment) }) };
      // The forward detections join the regime and the level once: buys hold at L1+, and every policy check sees the
      // higher of the forward level and Ballast's own. Without a risk block nothing changes.
      const forward = riskAssessment?.detections ?? [];
      const level = Math.max(baseLevel, riskAssessment?.level ?? 0) as Level;
      const riskEvent = riskAssessment ? riskEventOf(riskAssessment) : undefined;

      // Sized to the mandate's own order cap, halved at L1 as the level gate halves it, so a sized order passes both.
      const orderCapPct = m.limits.policy.maxOrderPctOfTreasury * (level === 1 ? m.limits.l1OrderCapFactor : 1);
      // One decision through the engines (A7.2, #54), recorded with every input before anything acts on it, so replaying
      // the audit log makes the same one. A record that can't be appended stops the tick: nothing is proposed unrecorded.
      const record = decide(reading, {
        portfolio: { volatileUsd: volatile.usd!, reserveUsd, cashUsd }, bounds: weightBoundsOf(m),
        sizing: { dcaUnitsUsed: state.dcaUnitsUsed }, whipsaw: state.whipsaw as WhipsawState, regime: regimeFrom([...market, ...faults, ...forward]),
      }, { ...ENGINE_DEFAULTS, sizing: { ...ENGINE_DEFAULTS.sizing, maxOrderPctOfTreasury: orderCapPct } }, {
        ctx: {
          treasuryValueUsd: total, turnoverTodayUsd, ordersLastHour, quotedSlippageBps: 0,
          venueExposureUsd: volatile.usd!, cashUsd: stable.usd!, spendsCashUsd: 0, level,
        },
        config: policyConfigOf(m),
      }, {
        volatile: VOLATILE, reserve: STABLE, prices, decimals, maxSlippageBps: m.limits.policy.maxSlippageBps,
      });
      const { intent, policy: verdict, proposal } = record;
      // The faults behind a system-fault regime, by reason: the regime alone doesn't say which.
      const detail = { zone: intent.zone, level, ...(reading.frozen ? { frozen: reading.reason } : { twap: reading.twap15m, ema: reading.ema30d }),
        ...(faults.length > 0 && { faults: faults.map(f => f.reason) }) };
      const ballastDecision = ((): Decision => {
        if (intent.action === "hold") return { skipped: "ballast holds", reason: intent.reason, ...detail };
        if (verdict?.result.ok === false) return { skipped: "policy refused", rule: verdict.result.rule, reason: verdict.result.detail, ...detail };
        if (!proposal || proposal.sizeUsd === null) return { skipped: "below a cent", ...detail };
        const { sizeUsd, legs } = proposal;
        if (!legs.ok) return { skipped: "no legs", code: legs.code, ...detail };
        const approval = verdict?.result.ok === "needs-approval" ? `; ${verdict.result.reason}` : "";
        return {
          requestId: newRequestId(agent),
          body: { legs: legs.legs, expiresAt: new Date(at + proposalHours * HOUR_MS).toISOString(), note: `Ballast ${intent.zone}: ${intent.action === "buy-volatile" ? "buy" : "sell"} ${sizeUsd} USD of wNEAR${approval}`.slice(0, 280) },
          intent: { ...intent, sizeUsd: Number(sizeUsd) }, level, detail: { ...detail, sizeUsd },
        };
      })();
      // A de-risk sell the forward risk agent sized passes policy, needs no cooldown and has legs: it is the tick's one
      // proposal, for the owner to approve. Ballast's own decision is still recorded, but names no request it never made.
      const riskProposal = riskAssessment?.derisk?.proposal;
      const riskLegs = riskProposal?.legs.ok ? riskProposal.legs.legs : null;
      const riskWins = Boolean(riskLegs && riskIntent && riskRequestId);
      const decision: Decision = riskWins
        ? {
          requestId: riskRequestId!, level,
          body: { legs: riskLegs!, expiresAt: new Date(at + proposalHours * HOUR_MS).toISOString(),
            note: `Stabilization de-risk: sell ${riskProposal!.sizeUsd} USD of wNEAR into USDC${riskAssessment!.derisk!.policy.ok === "needs-approval" ? `; ${riskAssessment!.derisk!.policy.reason}` : ""}`.slice(0, 280) },
          intent: riskIntent!, detail: { zone: riskIntent!.zone, level },
          ...(riskEvent && { risk: riskEvent }),
        }
        : { ...ballastDecision, ...(riskEvent && { risk: riskEvent }) };
      // A proposal is recorded under the requestId its request will be stored and sent with (#172); one risk won is named
      // in its own `risk` record, so Ballast's decision names no request it isn't making.
      const ballastRequestId: string | undefined = !riskWins && "requestId" in ballastDecision && typeof ballastDecision.requestId === "string"
        ? ballastDecision.requestId : undefined;
      await audit.append({ ...record, organization, agent, ...(ballastRequestId !== undefined && { requestId: ballastRequestId }) });

      if (intent.action === "hold") {
        // A hold may re-arm a disarmed zone: written only when it changes.
        const deviation = reading.frozen ? null : deviationPct(reading.twap15m, reading.ema30d);
        const next = nextState(state.whipsaw as WhipsawState, intent, deviation, at);
        if (JSON.stringify(next) !== JSON.stringify(state.whipsaw)) await states.change(organization, agent, s => ({ ...s, whipsaw: next }));
      }
      return decision;
    },

    /**
     * Ballast's step for a diversified agent (#221): several volatile sleeves, each with its own oracle history, bands,
     * DCA units and anti-whipsaw state, sharing one reserve and one cash floor. It proposes at most one trade a tick,
     * sells before buys, through the policy and the book's own venue and class caps (`checkBookExposure`); every proposal
     * is still the owner's to approve.
     *
     * What it can't honestly price, it doesn't trade: a sleeve with no holding has no platform price, so it holds rather
     * than being guessed at; an asset the registry or the platform's proposal list doesn't know is refused; and a config
     * whose terms the compiler refuses proposes nothing. The cash the floor counts is `runwayCash`: stablecoins in full,
     * and a cash-like real-world asset only when the RWA phase is on and it can be redeemed inside its horizon.
     */
    async decideDiversified(organization: string, agent: string, settings: BallastSettings, overview: OwnerOutput<"overview">, proposalHours: number,
      risk?: RiskSettings, autopilotOn: boolean | null = null, assessmentOnly = false, unreconciled: number | null = null): Promise<Decision> {
      const at = now();
      if (!settings.diversification) return { skipped: "no diversification terms" };

      // The book, by registry entry: an asset the registry doesn't know can't be counted at any venue, so the tick holds.
      const entries: { entry: AssetEntry; row: Holding }[] = [];
      for (const row of overview.book) {
        const entry = assetById(row.asset) ?? assetBySymbol(row.symbol);
        if (!entry) return { skipped: "the book holds an asset the registry doesn't know", assets: [row.asset] };
        entries.push({ entry, row });
      }
      const unusable = entries.filter(({ row }) => row.usd === null || !(row.usd >= 0) || row.price === null || !(row.price > 0));
      if (unusable.length > 0) return { skipped: "unpriced", assets: unusable.map(({ row }) => row.asset) };
      const total = entries.reduce((sum, { row }) => sum + row.usd!, 0);
      if (!(total > 0)) return { skipped: "empty" };
      const rowOf = (symbol: string) => entries.find(({ entry }) => entry.symbol === symbol)?.row;

      const compiled = compileMandate(mandateAnswersOf(settings, total), settings.profile as ProfileName);
      if (!compiled.ok) return { skipped: "mandate refused", problems: compiled.problems };
      const { mandate: m, cashFloorUsd } = compiled;
      const terms = m.diversification;
      if (!terms) return { skipped: "no diversification terms" };

      // Every holding must be a sleeve of the book or a stablecoin: anything else (a real-world asset, say) isn't
      // tradable through this path yet, and quietly folding it into cash would misstate both the floor and the caps.
      const stableEntries = entries.filter(({ entry }) => entry.class === "stable");
      const sleeveSymbols = new Set(terms.sleeves.map(s => s.asset));
      const outside = entries.filter(({ entry }) => entry.class !== "stable" && !sleeveSymbols.has(entry.symbol));
      if (outside.length > 0) return { skipped: "the book holds an asset outside the sleeves and stablecoins", assets: outside.map(({ entry }) => entry.symbol) };
      // A stablecoin the mandate didn't split into is not cash this book may count: holding one outside the terms would
      // overstate the floor and the reserve, so the tick holds and the owner adds it to the split or moves it out.
      const outsideStable = stableEntries.filter(({ entry }) => !(entry.symbol in terms.stableSplit));
      if (outsideStable.length > 0) return { skipped: "the book holds a stablecoin outside the mandate's split", assets: outsideStable.map(({ entry }) => entry.symbol) };
      if (stableEntries.length === 0) return { skipped: "the book holds no stablecoin for the cash floor" };

      // Each sleeve's own oracle history, and its market moves. A sleeve with no holding has no platform price: it holds.
      const readings: Record<string, OracleReading> = {};
      const markets: Record<string, ReturnType<typeof detectMarketMoves>> = {};
      const volatileUsd: Record<string, number> = {};
      const hourlySeen: Record<string, Sample[]> = {};
      for (const sleeve of terms.sleeves) {
        const entry = assetBySymbol(sleeve.asset);
        if (!entry || entry.id === null) return { skipped: `sleeve ${sleeve.asset} isn't in the asset registry` };
        if (!proposable(entry)) return { skipped: `sleeve ${sleeve.asset} isn't among the platform's proposal assets` };
        const id = entry.id, row = rowOf(entry.symbol);
        volatileUsd[entry.symbol] = row?.usd ?? 0;
        const before = history.of(id);
        const seen = hourly(before);
        if (row && row.price !== null && row.price > 0) {
          const quotes = await feeds.quotes(entry);
          const reading = readOracle(id, quotes, before, at);
          const checked = checkQuotes(id, quotes, at);
          if (!checked.frozen) await history.record(id, at, checked.median);
          readings[entry.symbol] = reading;
          hourlySeen[entry.symbol] = seen.concat(checked.frozen ? [] : [{ at, price: checked.median }]);
          markets[entry.symbol] = detectMarketMoves(hourlySeen[entry.symbol]!, at);
        } else markets[entry.symbol] = detectMarketMoves(seen, at);
      }

      // The cash the floor may count, and the protected part of it. An RWA outside the book doesn't count until the RWA
      // phase is on and the platform lists it (`runwayCash` says why each fallback is left out).
      const runway = runwayCash(entries.map(({ entry, row }) => ({ asset: entry.symbol, usd: row.usd! })),
        { rwaEnabled: rwaOn(terms), horizonDays: terms.rwa.cashHorizonDays });
      if (runway.cashUsd === null) return { skipped: "the cash floor can't be judged", excluded: runway.excluded };
      const stableUsd = stableEntries.reduce((sum, { row }) => sum + row.usd!, 0);
      const cashUsd = Math.min(runway.cashUsd, cashFloorUsd);
      const reserveUsd = Math.max(0, stableUsd - cashUsd);

      const stablecoinPrices = Object.fromEntries(await Promise.all(stableEntries.map(async ({ entry }) => [entry.symbol, await stablePrice(entry, at)])));
      const faults = detectFaults({
        oracleFrozen: null, quotedSlippageBps: null, venueUp: true, stablecoinPrices,
        cashUsd: runway.cashUsd, cashFloorUsd, unknownOutcomes: 0, bookUsd: total, unreconciledUsd: unreconciled,
      }).filter(d => !NOT_JUDGED_HERE.has(d.detector));
      // What a frozen sleeve's own reading adds: source disagreement or a missing source, never another sleeve's fault.
      const sourceFaults = (reading: OracleReading | undefined) => reading?.frozen
        ? detectFaults({ oracleFrozen: reading.reason, quotedSlippageBps: 0, venueUp: true, stablecoinPrices: { USDC: 1 }, cashUsd: 1, cashFloorUsd: 1,
          unknownOutcomes: 0, bookUsd: 1, unreconciledUsd: 0 }).filter(d => !NOT_JUDGED_HERE.has(d.detector))
        : [];
      const allFaults = [...faults, ...Object.values(readings).flatMap(sourceFaults)];
      const baseLevel = Math.max(...Object.values(markets).map(highestLevel), highestFaultLevel(allFaults), m.governance.startLevel) as Level;

      const state = states.find(organization, agent);
      const recent = state.proposed.filter(p => p.at > at - DAY_MS);
      const sleeveStates = Object.fromEntries(terms.sleeves.map(s => [s.asset, sleeveOf(state, s.asset)]));
      const decimals = Object.fromEntries(Object.entries(PROPOSAL_TOKENS).map(([asset, token]) => [asset, token.decimals]));

      // The stabilization agent on the multi-sleeve book (#220, #221): the book is every holding with its venue and the
      // bridges it crossed, each volatile sleeve's own hourly history, and the same mandate, cash and policy context a
      // sleeve's trade is checked under. Gold, a price exposure, is a risk asset. Its record goes to the log with every
      // input before anything acts on it, and a record that can't be appended stops the tick.
      let riskAssessment: RiskAssessment | undefined, riskInput: RiskInput | undefined;
      let riskIntent: Intent | undefined, riskRequestId: string | undefined;
      if (risk) {
        const projection = projectionOf(risk), scenarios = scenariosOf(risk);
        const label = (venue: string) => VENUES[venue]?.label ?? venue;
        const book: Book = entries.map(({ entry, row }) => ({
          asset: entry.id ?? entry.symbol, symbol: entry.symbol, class: entry.class === "stable" ? "stable" as const : "volatile" as const, usd: row.usd!,
          venue: label(VENUE_IDS.intents), ...(entry.venues.length > 1 && { via: entry.venues.slice(1).map(label) }),
        }));
        // The cooldown runs from the newest trade of any sleeve: one agent, one account, one proposal a tick.
        const acted = terms.sleeves.map(s => sleeveStates[s.asset]!.whipsaw.lastActionAt).filter((x): x is number => typeof x === "number");
        const lastAction = acted.length > 0 ? Math.max(...acted) : null;
        const priced = entries.filter(({ entry, row }) => entry.id !== null && proposable(entry) && row.price !== null && row.price > 0);
        const from = at - projection.lookbackDays * DAY_MS - projection.maxGapMs;
        riskInput = {
          at, book,
          terms: { monthlySpendUsd: settings.monthlySpendUsd, operatingCashMonths: settings.operatingCashMonths },
          history: Object.fromEntries(entries.flatMap(({ entry }) => entry.class !== "stable" && hourlySeen[entry.symbol] ? [[entry.id ?? entry.symbol, hourlySeen[entry.symbol]!.filter(sample => sample.at >= from)]] : [])),
          thresholds: riskThresholdsOf(m, settings.risk),
          projection, scenarios, autopilotOn: autopilotOn ?? null,
          trade: {
            turnoverTodayUsd: recent.reduce((sum, p) => sum + p.sizeUsd, 0), ordersLastHour: recent.filter(p => p.at > at - HOUR_MS).length, quotedSlippageBps: 0,
            cashUsd: runway.cashUsd, config: policyConfigOf(m), bounds: weightBoundsOf(m), baseLevel,
            lastActionAt: lastAction,
            cooldownMs: ENGINE_DEFAULTS.whipsaw.cooldownMs,
            pricing: { prices: Object.fromEntries(priced.map(({ entry, row }) => [entry.id!, decimalOf(row.price!)])), decimals, maxSlippageBps: m.limits.policy.maxSlippageBps },
          },
        };
        riskAssessment = assessRisk(riskInput);
        // While autopilot runs nothing is proposed (two proposers would race), so a de-risk names no request.
        if (riskAssessment.derisk?.proposal && autopilotOn !== true && !assessmentOnly && allFaults.length === 0) { riskIntent = riskAssessment.derisk.intent; riskRequestId = newRequestId(agent); }
        await audit.append({ kind: "risk", organization, agent, input: riskInput, assessment: riskAssessment,
          ...(riskRequestId !== undefined && { requestId: riskRequestId }) });
      }
      const riskEvent = riskAssessment ? riskEventOf(riskAssessment) : undefined;
      if (assessmentOnly) return { skipped: "assessment only", ...(riskAssessment && { risk: riskEventOf(riskAssessment) }) };
      // While autopilot runs, Ballast decides nothing: the risk agent has assessed it and recommended pausing it if needed.
      if (autopilotOn === true) return { skipped: "autopilot", ...(riskEvent && { risk: riskEvent }) };
      // The forward detections join each sleeve's regime and the level once: buys hold at L1+, and every policy check sees
      // the higher of the forward level and Ballast's own. Without a risk block nothing changes.
      const forward = riskAssessment?.detections ?? [];
      const level = Math.max(baseLevel, riskAssessment?.level ?? 0) as Level;
      const regimes: Record<string, Regime> = Object.fromEntries(terms.sleeves.map(s =>
        [s.asset, regimeFrom([...(markets[s.asset] ?? []), ...faults, ...sourceFaults(readings[s.asset]), ...forward])]));

      const holdings: BookHoldings = { volatileUsd, reserveUsd, cashUsd };
      // Sized to the mandate's own order cap, halved at L1 as the level gate halves it, so a sized order passes both.
      const orderCapPct = m.limits.policy.maxOrderPctOfTreasury * (level === 1 ? m.limits.l1OrderCapFactor : 1);
      const engine: EngineConfig = { ...ENGINE_DEFAULTS, sizing: { ...ENGINE_DEFAULTS.sizing, maxOrderPctOfTreasury: orderCapPct } };
      const decided = evaluateSleeves(readings, holdings, sleeveBookOf(terms, m.bounds.volatileMaxPct), sleeveStates, regimes, engine);
      // The sleeves that want to trade, sells first: each is tried in turn, so one the policy or the book check refuses
      // doesn't stop the next.
      const candidates = decided.filter(d => d.intent.action !== "hold");

      // A holding sleeve may re-arm a disarmed zone, at its own bands: written only when it changes.
      const rearmHolds = async () => {
        const updates: Record<string, WhipsawState> = {};
        for (const d of decided) {
          if (d.intent.action !== "hold" || !d.input) continue;
          const reading = readings[d.asset];
          if (!reading) continue;
          const deviation = reading.frozen ? null : deviationPct(reading.twap15m, reading.ema30d);
          const current = sleeveStates[d.asset]!;
          const next = nextState(current.whipsaw, d.intent, deviation, at, d.config.whipsaw, d.config.bands);
          if (JSON.stringify(next) !== JSON.stringify(current.whipsaw)) updates[d.asset] = next;
        }
        if (Object.keys(updates).length === 0) return;
        await states.change(organization, agent, s => ({
          ...s, sleeves: Object.fromEntries(terms.sleeves.map(sl => [sl.asset, { ...sleeveOf(s, sl.asset), ...(updates[sl.asset] && { whipsaw: updates[sl.asset]! }) }])),
        }));
      };

      const policyCtx = (venueExposureUsd: number) => ({
        treasuryValueUsd: total, turnoverTodayUsd: recent.reduce((sum, p) => sum + p.sizeUsd, 0),
        ordersLastHour: recent.filter(p => p.at > at - HOUR_MS).length, quotedSlippageBps: 0,
        venueExposureUsd, cashUsd: runway.cashUsd!, spendsCashUsd: 0, level,
      });
      const detailsOf = (d: (typeof decided)[number]) => {
        const reading = readings[d.asset];
        return { asset: d.asset, zone: d.intent.zone, level,
          ...(reading?.frozen ? { frozen: reading.reason } : reading ? { twap: reading.twap15m, ema: reading.ema30d } : {}),
          ...(faults.length > 0 && { faults: faults.map(f => f.reason) }) };
      };

      /** The tick's decision with the risk agent's event beside it, as the two-asset step reports it. */
      const done = (decision: Decision): Decision => riskEvent ? { ...decision, risk: riskEvent } : decision;
      // A de-risk sell the forward risk agent sized passes policy, needs no cooldown and has legs: it is the tick's one
      // proposal, for the owner to approve, and Ballast's sleeves make none this tick (so no decision of theirs names a
      // request it never made). The sleeve it sells is the one whose cooldown and zone it disarms.
      const riskProposal = riskAssessment?.derisk?.proposal;
      const riskLegs = riskProposal?.legs.ok ? riskProposal.legs.legs : null;
      const sold = riskLegs ? assetById(riskLegs[0].from) : undefined;
      if (riskLegs && riskProposal && riskIntent && riskRequestId && riskAssessment?.derisk && sold) {
        await rearmHolds();
        return done({
          requestId: riskRequestId, asset: sold.symbol, level,
          body: { legs: riskLegs, expiresAt: new Date(at + proposalHours * HOUR_MS).toISOString(),
            note: `Stabilization de-risk: sell ${riskProposal.sizeUsd} USD of ${sold.symbol}${riskAssessment.derisk.policy.ok === "needs-approval" ? `; ${riskAssessment.derisk.policy.reason}` : ""}`.slice(0, 280) },
          intent: riskIntent, detail: { asset: sold.symbol, zone: riskIntent.zone, level },
        });
      }

      if (candidates.length === 0) {
        const first = decided.find(d => d.input !== null && readings[d.asset] !== undefined);
        if (!first) return done({ skipped: "no sleeve can be priced", sleeves: terms.sleeves.map(s => s.asset) });
        // A hold records no policy or pricing (`decide`), so the legs' assets here never reach the record.
        const record = decide(readings[first.asset]!, first.input!, first.config, { ctx: policyCtx(volatileUsd[first.asset] ?? 0), config: policyConfigOf(m) },
          { volatile: PROPOSAL_ASSETS.wNEAR, reserve: PROPOSAL_ASSETS.USDC, prices: {}, decimals: {}, maxSlippageBps: m.limits.policy.maxSlippageBps });
        await audit.append({ ...record, organization, agent });
        await rearmHolds();
        return done({ skipped: "ballast holds", reason: first.intent.reason, ...detailsOf(first), sleeves: decided.map(d => [d.asset, d.intent.action]) });
      }

      // The reserve leg: the first stablecoin in the split that the platform lists and the book prices.
      const reserve = Object.keys(terms.stableSplit).map(coin => assetBySymbol(coin)).find((e): e is AssetEntry => e !== undefined && proposable(e) && rowOf(e.symbol) !== undefined);
      if (!reserve) return done({ skipped: "no proposable stablecoin in the reserve split" });
      const reserveRow = rowOf(reserve.symbol), reserveId = reserve.id;
      const reservePrice = reserveRow?.price ?? null;
      if (reservePrice === null || reserveId === null) return done({ skipped: "no fresh price for the reserve" });
      const bookHoldings = entries.map(({ entry, row }) => ({ asset: entry.symbol, usd: row.usd! }));

      /** One sleeve's trade through the policy and the book check, recorded before anything acts; a refusal says why. */
      const attempt = async (chosen: (typeof decided)[number]): Promise<Decision> => {
        const entry = assetBySymbol(chosen.asset), chosenReading = readings[chosen.asset], chosenInput = chosen.input;
        if (!entry || entry.id === null) return { skipped: `sleeve ${chosen.asset} isn't in the asset registry` };
        if (!chosenReading || !chosenInput) return { skipped: "the sleeve's reading or book can't be read", asset: chosen.asset };
        const volatileRow = rowOf(entry.symbol), volatileId = entry.id;
        if (!volatileRow || volatileRow.price === null) return { skipped: "no fresh price for the trade's two assets", asset: chosen.asset };
        const bookCtx = bookContext(entry.symbol, bookHoldings, total);
        if (!bookCtx) return { skipped: "the book's venue exposure can't be read", asset: chosen.asset };
        const record = decide(chosenReading, chosenInput, chosen.config, {
          ctx: policyCtx(bookCtx.venueUsd[VENUE_IDS.intents] ?? 0), config: policyConfigOf(m),
          book: { ctx: bookCtx, limits: { venueCapsPct: terms.venueCapsPct, classCapsPct: terms.classCapsPct } },
        }, {
          volatile: volatileId, reserve: reserveId,
          prices: { [volatileId]: decimalOf(volatileRow.price), [reserveId]: decimalOf(reservePrice) },
          decimals, maxSlippageBps: m.limits.policy.maxSlippageBps,
        });
        const { intent, policy: verdict, proposal } = record;
        const detail = detailsOf(chosen);
        const decision = ((): Decision => {
          if (verdict?.result.ok === false) return { skipped: "policy refused", rule: verdict.result.rule, reason: verdict.result.detail, ...detail };
          if (!proposal || proposal.sizeUsd === null) return { skipped: "below a cent", ...detail };
          const { sizeUsd, legs } = proposal;
          if (!legs.ok) return { skipped: "no legs", code: legs.code, ...detail };
          const approval = verdict?.result.ok === "needs-approval" ? `; ${verdict.result.reason}` : "";
          return {
            requestId: newRequestId(agent), asset: entry.symbol,
            body: { legs: legs.legs, expiresAt: new Date(at + proposalHours * HOUR_MS).toISOString(), note: `Ballast ${intent.zone}: ${intent.action === "buy-volatile" ? "buy" : "sell"} ${sizeUsd} USD of ${entry.symbol}${approval}`.slice(0, 280) },
            intent: { ...intent, sizeUsd: Number(sizeUsd) }, level, detail: { ...detail, sizeUsd },
          };
        })();
        await audit.append({ ...record, organization, agent, ...("skipped" in decision ? {} : { requestId: decision.requestId }) });
        return decision;
      };

      // At most one proposal a tick: the first sleeve whose trade passes. With none, the first refusal says why.
      let refused: Decision | undefined;
      for (const chosen of candidates) {
        const decision = await attempt(chosen);
        if (!("skipped" in decision)) { await rearmHolds(); return done(decision); }
        refused ??= decision;
      }
      await rearmHolds();
      return done(refused!);
    },

    /**
     * Records a proposal before its request is stored or sent: it counts towards turnover and the order rate, and it
     * disarms its zone and starts the cooldown, whatever the owner answers. A crash after this and before the request is
     * stored leaves a proposal counted that was never made, which only holds back more. One the platform refuses without
     * storing it is undone (`unmade`).
     */
    proposed: (organization: string, agent: string, requestId: string, intent: Intent, asset?: string) => states.change(organization, agent, s => {
      const proposed = [...s.proposed.filter(p => p.at > now() - PROPOSED_MS)];
      // A diversified proposal disarms its own sleeve only: the other sleeves keep their cooldowns and DCA units.
      if (asset) {
        const before = sleeveOf(s, asset), whipsaw = nextState(before.whipsaw, intent, null, intent.at);
        return { ...s, sleeves: { ...s.sleeves, [asset]: { ...before, whipsaw } },
          proposed: [...proposed, { requestId, at: intent.at, sizeUsd: intent.sizeUsd, dcaUnits: intent.dcaUnits, settled: false, asset, whipsawBefore: before.whipsaw }] };
      }
      return { ...s, whipsaw: nextState(s.whipsaw as WhipsawState, intent, null, intent.at),
        proposed: [...proposed, { requestId, at: intent.at, sizeUsd: intent.sizeUsd, dcaUnits: intent.dcaUnits, settled: false, whipsawBefore: s.whipsaw }] };
    }),

    /** A proposal the platform refused without storing it (#190): it was never made, so it's undone. */
    unmade: (organization: string, agent: string, requestId: string) => states.change(organization, agent, s => {
      const p = s.proposed.find(x => x.requestId === requestId);
      return !p || p.settled ? null : undone(s, p);
    }),

    /**
     * A proposal of Ballast's ended: an executed buy spends its DCA units, once; any other end spends none. One the owner
     * rejected or let expire still holds its zone and counts, so the same trade isn't put straight back to them. One the
     * platform invalidated (the agent, its policy or the owner's strategy changed after it was made) is undone as an
     * unmade one is (#217): nobody decided on it, so Ballast decides again under what changed.
     */
    settled: (organization: string, agent: string, requestId: string, state: string) => states.change(organization, agent, s => {
      const p = s.proposed.find(x => x.requestId === requestId);
      if (!p || p.settled) return null;
      if (state === "invalidated") return undone(s, p);
      const spent = state === "executed" ? p.dcaUnits : 0;
      if (p.asset) {
        const before = sleeveOf(s, p.asset);
        return { ...s, sleeves: { ...s.sleeves, [p.asset]: { ...before, dcaUnitsUsed: before.dcaUnitsUsed + spent } },
          proposed: s.proposed.map(x => x.requestId === requestId ? { ...x, settled: true } : x) };
      }
      return {
        ...s, dcaUnitsUsed: s.dcaUnitsUsed + spent,
        proposed: s.proposed.map(x => x.requestId === requestId ? { ...x, settled: true } : x),
      };
    }),
  };
}
export type Ballast = ReturnType<typeof createBallast>;
