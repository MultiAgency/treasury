import { PROPOSAL_TOKENS, type OwnerOutput } from "@multiagency/sdk";
import { z } from "zod";
import {
  ENGINE_DEFAULTS, checkQuotes, compileMandate, decide, deviationPct, detectFaults, detectMarketMoves, highestFaultLevel,
  highestLevel, nextState, ORACLE_DEFAULTS, policyConfigOf, PROPOSAL_ASSETS, readOracle, regimeFrom, weightBoundsOf,
  type DecisionRecord, type Intent, type Level, type OracleLimits, type ProfileName, type Sample, type WhipsawState,
} from "../../../packages/core/src/index.ts";
import { createRecords } from "./records.ts";
import { newRequestId, type Body } from "./requests.ts";

/**
 * What the owner chose for an agent `watch` runs Ballast for (#47): a profile and the mandate answers the platform can't
 * read. The treasury's value comes from `overview` on every tick, so the mandate is compiled again each time and a
 * floor the cash share can no longer hold refuses, never proposes.
 */
export const ballastSettings = z.strictObject({
  profile: z.enum(["conservative", "balanced", "growth"]),
  monthlySpendUsd: z.number().positive(),
  operatingCashMonths: z.number().positive().max(36),
  destinations: z.array(z.string().min(2)).min(1),
  approvers: z.array(z.string().min(2)).min(1),
});
export type BallastSettings = z.output<typeof ballastSettings>;

/** H5 (ADR 3): wNEAR is the volatile asset, USDC the reserve and the operating cash. */
const VOLATILE = PROPOSAL_ASSETS.wNEAR, STABLE = PROPOSAL_ASSETS.USDC;
const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
/** History kept per asset: the EMA's 30-day warm-up, plus a margin. */
const HISTORY_MS = 35 * DAY_MS;
/** A proposal is kept for its turnover a day, and for its DCA units until it settles or could no longer execute (7 days). */
const PROPOSED_MS = 8 * DAY_MS;

/**
 * The only price source until H5's three fetchers ship: the platform's own, from `overview`. One source can't meet the
 * oracle's three, so this names the exception rather than lowering the default; everything else is the oracle's own.
 */
export const OVERVIEW_ORACLE: OracleLimits = { ...ORACLE_DEFAULTS, minSources: 1 };
const OVERVIEW_SOURCE = "platform-overview";
/** Fault detectors whose inputs `watch` can't observe; what bounds each instead is in `createBallast`. */
const NOT_JUDGED_HERE = new Set(["thin-liquidity", "agent-malfunction"]);

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
/** A proposal Ballast made, with the anti-whipsaw state from before it (`whipsawBefore`), so one never stored can be undone. */
const proposed = z.strictObject({ requestId: z.string().min(1), at: z.number(), sizeUsd: z.number().positive(), dcaUnits: z.number().min(0), settled: z.boolean(),
  whipsawBefore: whipsawState.optional() });
const engineState = z.strictObject({
  organization: z.string().min(1), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  whipsaw: whipsawState, dcaUnitsUsed: z.number().min(0), proposed: z.array(proposed),
});
type EngineState = z.output<typeof engineState>;

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
const decimalOf = (price: number) => price.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");

type Holding = OwnerOutput<"overview">["book"][number];
/**
 * A Ballast decision as the audit log records it (A7.2, #54): the engines' record, the agent it was made for, and for
 * one that proposes, the `requestId` its request is stored and sent under (#172). A recorded `requestId` with no
 * request or proposal under it was never stored (the store was full, or the server stopped first).
 */
export type DecisionEntry = DecisionRecord & { organization: string; agent: string; requestId?: string };
/** What one tick decided: a proposal to make under its `requestId`, with what to record once it's stored, or why not. */
export type Decision =
  | { requestId: string; body: Body; intent: Intent; level: Level; detail: Record<string, unknown> }
  | { skipped: string; [detail: string]: unknown };

/**
 * Ballast's step for `watch` (#47): the platform's price through the oracle, the band engine, the policy and `legsFor`,
 * to one swap proposal or a reason to hold. Every proposal is still the owner's to approve, so a level that asks for a
 * human (L2, L3 sells) proposes; one that refuses (L3 buys, L4) doesn't.
 *
 * The sleeves come from the book: wNEAR is volatile; USDC up to the mandate's cash floor is operating cash, and the rest
 * is the reserve the DCA draws on, so a buy never reaches into the floor. Slippage isn't quoted before proposing (app
 * access has no quote): it's bounded by the leg's `minAmountOut` at the mandate's limit, which the platform refuses if the
 * quote is worse, so the policy's own slippage rule is given 0 and thin liquidity isn't a detection here. Unresolved
 * operations already hold `watch` before this runs; reconciliation is A19's.
 */
export function createBallast({ history, states, audit, now = Date.now }: {
  history: PriceHistory; states: EngineStates;
  /** Where every decision is recorded with its inputs (A7.2, #54): the server's hash-chained audit log. */
  audit: { append(entry: DecisionEntry): Promise<void> };
  now?: () => number;
}) {
  return {
    async decide(organization: string, agent: string, settings: BallastSettings, overview: OwnerOutput<"overview">, proposalHours: number): Promise<Decision> {
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

      // The oracle: this tick's quote checked alone first, so its median joins the history even while the EMA warms up.
      const observedAt = Date.parse(volatile.priceUpdatedAt ?? "");
      const quotes = [{ source: OVERVIEW_SOURCE, asset: VOLATILE, price: volatile.price!, observedAt }];
      const before = history.of(VOLATILE);
      const reading = readOracle(VOLATILE, quotes, before, at, OVERVIEW_ORACLE);
      const checked = checkQuotes(VOLATILE, quotes, at, OVERVIEW_ORACLE);
      if (!checked.frozen) await history.record(VOLATILE, at, checked.median);
      // The detectors read one sample an hour, as H9 calibrated them, plus this reading.
      const hourlySeen = hourly(before).concat(checked.frozen ? [] : [{ at, price: checked.median }]);

      const market = detectMarketMoves(hourlySeen, at);
      // Thin liquidity and agent malfunction need a quote and a reconciliation this step doesn't have (see above): their
      // inputs are given as unknown, and their detections are the only ones left out.
      const faults = detectFaults({
        oracleFrozen: reading.frozen ? reading.reason : null, quotedSlippageBps: null, venueUp: true,
        stablecoinPrices: { USDC: stable.price }, cashUsd: stable.usd, cashFloorUsd, unknownOutcomes: null, expectedUsd: null, reportedUsd: null,
      }).filter(d => !NOT_JUDGED_HERE.has(d.detector));
      const level = Math.max(highestLevel(market), highestFaultLevel(faults), m.governance.startLevel) as Level;
      const reserveUsd = Math.max(0, stable.usd! - cashFloorUsd), cashUsd = stable.usd! - reserveUsd;

      const state = states.find(organization, agent);
      // Sized to the mandate's own order cap, halved at L1 as the level gate halves it, so a sized order passes both.
      const orderCapPct = m.limits.policy.maxOrderPctOfTreasury * (level === 1 ? m.limits.l1OrderCapFactor : 1);
      const recent = state.proposed.filter(p => p.at > at - DAY_MS);
      // One decision through the engines (A7.2, #54), recorded with every input before anything acts on it, so replaying
      // the audit log makes the same one. A record that can't be appended stops the tick: nothing is proposed unrecorded.
      const record = decide(reading, {
        portfolio: { volatileUsd: volatile.usd!, reserveUsd, cashUsd }, bounds: weightBoundsOf(m),
        sizing: { dcaUnitsUsed: state.dcaUnitsUsed }, whipsaw: state.whipsaw as WhipsawState, regime: regimeFrom([...market, ...faults]),
      }, { ...ENGINE_DEFAULTS, sizing: { ...ENGINE_DEFAULTS.sizing, maxOrderPctOfTreasury: orderCapPct } }, {
        ctx: {
          treasuryValueUsd: total, turnoverTodayUsd: recent.reduce((sum, p) => sum + p.sizeUsd, 0),
          ordersLastHour: recent.filter(p => p.at > at - HOUR_MS).length, quotedSlippageBps: 0,
          venueExposureUsd: volatile.usd!, cashUsd: stable.usd!, spendsCashUsd: 0, level,
        },
        config: policyConfigOf(m),
      }, {
        volatile: VOLATILE, reserve: STABLE,
        prices: { [VOLATILE]: decimalOf(volatile.price!), [STABLE]: decimalOf(stable.price!) },
        decimals: Object.fromEntries(Object.entries(PROPOSAL_TOKENS).map(([asset, token]) => [asset, token.decimals])),
        maxSlippageBps: m.limits.policy.maxSlippageBps,
      });
      const { intent, policy: verdict, proposal } = record;
      const detail = { zone: intent.zone, level, ...(reading.frozen ? { frozen: reading.reason } : { twap: reading.twap15m, ema: reading.ema30d }) };
      const decision = ((): Decision => {
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
      // A proposal is recorded under the requestId its request will be stored and sent with (#172).
      await audit.append({ ...record, organization, agent, ...("skipped" in decision ? {} : { requestId: decision.requestId }) });

      if (intent.action === "hold") {
        // A hold may re-arm a disarmed zone: written only when it changes.
        const deviation = reading.frozen ? null : deviationPct(reading.twap15m, reading.ema30d);
        const next = nextState(state.whipsaw as WhipsawState, intent, deviation, at);
        if (JSON.stringify(next) !== JSON.stringify(state.whipsaw)) await states.change(organization, agent, s => ({ ...s, whipsaw: next }));
      }
      return decision;
    },

    /**
     * Records a proposal before its request is stored or sent: it counts towards turnover and the order rate, and it
     * disarms its zone and starts the cooldown, whatever the owner answers. A crash after this and before the request is
     * stored leaves a proposal counted that was never made, which only holds back more. One the platform refuses without
     * storing it is undone (`unmade`).
     */
    proposed: (organization: string, agent: string, requestId: string, intent: Intent) => states.change(organization, agent, s => ({
      ...s, whipsaw: nextState(s.whipsaw as WhipsawState, intent, null, intent.at),
      proposed: [...s.proposed.filter(p => p.at > now() - PROPOSED_MS),
        { requestId, at: intent.at, sizeUsd: intent.sizeUsd, dcaUnits: intent.dcaUnits, settled: false, whipsawBefore: s.whipsaw }],
    })),

    /**
     * A proposal the platform refused without storing it (#190): it was never made, so it's as if it hadn't been decided.
     * The zone and the cooldown go back to what they were before it, and it no longer counts towards turnover or the order
     * rate. `watch` sends nothing else for the agent while a request is unanswered, so nothing changed the state in between.
     * A proposal recorded before its state was kept (`whipsawBefore`) only stops counting.
     */
    unmade: (organization: string, agent: string, requestId: string) => states.change(organization, agent, s => {
      const p = s.proposed.find(x => x.requestId === requestId);
      if (!p || p.settled) return null;
      return { ...s, ...(p.whipsawBefore && { whipsaw: p.whipsawBefore }), proposed: s.proposed.filter(x => x.requestId !== requestId) };
    }),

    /** A proposal of Ballast's ended: an executed buy spends its DCA units, once; any other end spends none. */
    settled: (organization: string, agent: string, requestId: string, state: string) => states.change(organization, agent, s => {
      const p = s.proposed.find(x => x.requestId === requestId);
      if (!p || p.settled) return null;
      return {
        ...s, dcaUnitsUsed: s.dcaUnitsUsed + (state === "executed" ? p.dcaUnits : 0),
        proposed: s.proposed.map(x => x.requestId === requestId ? { ...x, settled: true } : x),
      };
    }),
  };
}
export type Ballast = ReturnType<typeof createBallast>;
