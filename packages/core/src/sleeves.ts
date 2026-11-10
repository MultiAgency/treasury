// Multi-sleeve strategy (#221): several volatile assets, each with its own target, bounds, bands, DCA units and
// anti-whipsaw state, sharing one reserve and one cash floor. Pure. Each sleeve is decided by the same band engine as
// the two-sleeve book (`evaluateBands`), on an `EngineInput` built here from the whole book, so every sleeve's decision
// is an ordinary decision record that `replayDecisions` replays, and a book of one sleeve is exactly the two-sleeve book.
//
// How the book becomes one sleeve's input:
// - the sleeve's holding is its `volatileUsd`;
// - its `reserveUsd` is its share of the reserve, by target weight, so the DCA budget is split by target and the
//   sleeves' buys together never spend more than the reserve;
// - everything else (cash, the rest of the reserve, the other sleeves) is its `cashUsd`, so the treasury's total is
//   unchanged and the order cap and bounds are percents of the whole book;
// - its bounds are its own, with the ceiling lowered so that all volatile sleeves together stay under the book's
//   volatile ceiling: room the other sleeves already use isn't room this one may buy into.

import { assetBySymbol } from "./assets.ts";
import { bandProblems, type Bands } from "./bands.ts";
import { evaluateBands, type EngineConfig, type EngineInput } from "./engine.ts";
import type { Intent } from "./bands.ts";
import type { OracleReading } from "./oracle.ts";
import { guarded, isNonNegative, isPct, report } from "./validate.ts";
import type { Regime, WhipsawState } from "./whipsaw.ts";

/** One volatile sleeve: its asset (a registry symbol), its target and the bounds it may drift in, in percent of the book. */
export type SleeveTerms = { asset: string; targetPct: number; minPct: number; maxPct: number; /** Its own band thresholds; the engine's otherwise. */ bands?: Bands };
/** The volatile sleeves and the ceiling on all of them together (the profile's `volatileMaxPct`). */
export type SleeveBook = { sleeves: readonly SleeveTerms[]; volatileMaxPct: number };

/** Holdings in USD: each sleeve's volatile asset by symbol, the reserve the DCA draws on, and protected operating cash. */
export type BookHoldings = { volatileUsd: Readonly<Record<string, number>>; reserveUsd: number; cashUsd: number };
/** One sleeve's own state, kept between decisions as the two-sleeve book keeps its one. */
export type SleeveState = { dcaUnitsUsed: number; whipsaw: WhipsawState };

/** What is wrong with the sleeves, if anything. */
export function sleeveProblems(book: SleeveBook): string[] {
  return guarded(() => {
    const r = report();
    r.need(Array.isArray(book.sleeves) && book.sleeves.length > 0, "a book needs at least one volatile sleeve");
    r.need(isPct(book.volatileMaxPct), "volatileMaxPct must be above 0 and at most 100");
    const seen = new Set<string>();
    let targets = 0;
    for (const s of book.sleeves) {
      const name = typeof s.asset === "string" ? s.asset : "?";
      r.need(typeof s.asset === "string" && s.asset.length > 0 && !seen.has(s.asset.toLowerCase()), `sleeve ${name}: needs an asset of its own`);
      seen.add(name.toLowerCase());
      r.need(isNonNegative(s.minPct) && isPct(s.targetPct) && isPct(s.maxPct) && s.minPct <= s.targetPct && s.targetPct <= s.maxPct,
        `sleeve ${name}: needs 0 ≤ min ≤ target ≤ max ≤ 100, target above 0`);
      if (s.bands !== undefined) for (const p of bandProblems(s.bands)) r.need(false, `sleeve ${name}: ${p}`);
      targets += isPct(s.targetPct) ? s.targetPct : 0;
    }
    r.need(targets <= book.volatileMaxPct + 1e-9, "the sleeves' targets add to more than the volatile ceiling");
    return r.problems;
  });
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/**
 * One sleeve's input to the band engine, or null when the book can't be read (an unknown sleeve, a negative or
 * non-finite holding, an empty book, or unusable sleeve terms): the caller holds.
 */
export function sleeveInput(asset: string, holdings: BookHoldings, book: SleeveBook, state: SleeveState, regime: Regime): EngineInput | null {
  if (sleeveProblems(book).length > 0) return null;
  const sleeve = book.sleeves.find(s => s.asset === asset);
  if (!sleeve) return null;
  const held = book.sleeves.map(s => holdings.volatileUsd[s.asset] ?? 0);
  if (![...held, holdings.reserveUsd, holdings.cashUsd].every(isNonNegative)) return null;
  const total = sum(held) + holdings.reserveUsd + holdings.cashUsd;
  if (!(total > 0)) return null;
  const mine = holdings.volatileUsd[asset] ?? 0;
  const share = sleeve.targetPct / sum(book.sleeves.map(s => s.targetPct));
  // One sleeve's share is the whole reserve, read as the reserve itself so a one-sleeve book's input is the two-sleeve one's.
  const reserveUsd = share === 1 ? holdings.reserveUsd : holdings.reserveUsd * share;
  const othersPct = ((sum(held) - mine) / total) * 100;
  // The other sleeves' weight lowers this one's ceiling; it never falls under its own floor, where the floor wins.
  const ceiling = othersPct === 0 ? Math.min(sleeve.maxPct, book.volatileMaxPct) : Math.max(sleeve.minPct, Math.min(sleeve.maxPct, book.volatileMaxPct - othersPct));
  return {
    portfolio: { volatileUsd: mine, reserveUsd, cashUsd: share === 1 ? holdings.cashUsd : total - mine - reserveUsd },
    bounds: { volatileMinPct: sleeve.minPct, volatileMaxPct: ceiling },
    sizing: { dcaUnitsUsed: state.dcaUnitsUsed }, whipsaw: state.whipsaw, regime,
  };
}

/** The engine configuration for one sleeve: its own bands, the rest shared. */
/**
 * One sleeve's engine config: its own bands, if it has them, and an order cap no larger than its asset's liquidity limit
 * (the registry's `maxOrderUsd`), so an order is sized to the limit rather than refused for it. The percent is rounded
 * down a millionth of a point so the sized order, a float, never lands over the limit.
 */
export function sleeveConfig(sleeve: SleeveTerms, config: EngineConfig, totalUsd: number): EngineConfig {
  const banded = sleeve.bands ? { ...config, bands: sleeve.bands } : config;
  const limitUsd = assetBySymbol(sleeve.asset)?.liquidity.maxOrderUsd;
  if (limitUsd === undefined || !(totalUsd > 0)) return banded;
  const limitPct = Math.floor(limitUsd / totalUsd * 100 * 1e6) / 1e6;
  return limitPct < banded.sizing.maxOrderPctOfTreasury ? { ...banded, sizing: { ...banded.sizing, maxOrderPctOfTreasury: limitPct } } : banded;
}

export type SleeveDecision = { asset: string; input: EngineInput | null; config: EngineConfig; intent: Intent };

/**
 * Every sleeve's intent for its own reading, in the order to act on them: sells first (they reduce risk and refill the
 * reserve), then buys, each in the sleeves' order. A sleeve whose book can't be read, or that has no reading, holds.
 */
export function evaluateSleeves(readings: Readonly<Record<string, OracleReading>>, holdings: BookHoldings, book: SleeveBook,
  states: Readonly<Record<string, SleeveState>>, regimes: Readonly<Record<string, Regime>>, config: EngineConfig): SleeveDecision[] {
  const totalUsd = Object.values(holdings.volatileUsd).reduce((sum, usd) => sum + usd, 0) + holdings.reserveUsd + holdings.cashUsd;
  const decided = book.sleeves.map((sleeve): SleeveDecision => {
    const reading = readings[sleeve.asset];
    const at = reading?.at ?? 0;
    const cfg = sleeveConfig(sleeve, config, totalUsd);
    const input = sleeveInput(sleeve.asset, holdings, book, states[sleeve.asset] ?? { dcaUnitsUsed: 0, whipsaw: {} }, regimes[sleeve.asset] ?? "system-fault");
    if (!reading || !input) {
      return { asset: sleeve.asset, input, config: cfg,
        intent: { id: `p-${at}`, zone: "hold", action: "hold", sizeUsd: 0, dcaUnits: 0, reason: !reading ? "no reading for this sleeve" : "the book can't be read for this sleeve", at } };
    }
    return { asset: sleeve.asset, input, config: cfg, intent: evaluateBands(reading, input, cfg) };
  });
  const rank = (d: SleeveDecision) => d.intent.action === "sell-volatile" ? 0 : d.intent.action === "buy-volatile" ? 1 : 2;
  return decided.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map(({ d }) => d);
}

/** The one-sleeve book the two-sleeve engine has always run: wNEAR at the profile's weight and bounds. */
export const singleSleeve = (asset: string, targetPct: number, bounds: { volatileMinPct: number; volatileMaxPct: number }): SleeveBook =>
  ({ sleeves: [{ asset, targetPct, minPct: bounds.volatileMinPct, maxPct: bounds.volatileMaxPct }], volatileMaxPct: bounds.volatileMaxPct });

