// Stablecoin diversification (#221, phase 2): the reserve and cash split across stablecoins by the mandate's targets,
// each with its own peg monitor, and a depeg of one moving its holding into the others. Pure: holdings and prices in,
// the moves to propose out. Each move is a swap between two stablecoins; nothing here sends one.
//
// It only plans moves the platform can carry out: a coin that isn't a proposal asset is reported as blocked, never
// traded. Today USDC is the only stablecoin among the proposal assets, so with today's platform every plan is either
// empty or blocked; the rules are written and tested now so they're ready when it lists another (#62's gap table).

import { ASSET_REGISTRY, proposable, type AssetEntry } from "./assets.ts";
import { FAULT_DEFAULTS } from "./faults.ts";
import type { Level } from "./levels.ts";
import { isNum, isPct, isPositive, report } from "./validate.ts";

/** A stablecoin held, by registry symbol: its USD value and its price, or null when it couldn't be priced. */
export type StableHolding = { asset: string; usd: number; price: number | null };
/** Percent of the stablecoin total each coin should hold; they add to 100. */
export type StableSplit = Readonly<Record<string, number>>;

export type StableLimits = {
  /** Depeg thresholds, as the fault detector's (L2 at 1%, L3 at 3%). */
  depegPct: { l2: number; l3: number };
  /** Rebalance to the split only once a coin is this many points of the stablecoin total off its target. */
  driftPoints: number;
  /** The largest single move, in USD. */
  maxMoveUsd: number;
};
export const STABLE_DEFAULTS: StableLimits = { depegPct: FAULT_DEFAULTS.depegPct, driftPoints: 5, maxMoveUsd: 25_000 };

/** A swap from one stablecoin to another, in USD at the coins' own prices. */
export type StableMove = { kind: "depeg-exit" | "rebalance"; from: string; to: string; sizeUsd: number; reason: string };
export type StablePlan = {
  /** Each coin's peg level: 0 on peg, 2 or 3 off it (as `detectFaults`), 3 with no usable price. */
  peg: Record<string, Level>;
  moves: StableMove[];
  /**
   * Moves the plan wanted that the platform can't carry, with why. `move` is the swap it wanted when the block is the
   * platform's list (a coin that isn't a proposal asset): the hedge planner (#221) shows it as blocked, not as nothing.
   */
  blocked: { asset: string; reason: string; move?: StableMove }[];
};

/** What is wrong with a split, if anything: stablecoins from the registry, each above 0, adding to 100. */
export function splitProblems(split: StableSplit, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): string[] {
  const r = report();
  const entries = Object.entries(split ?? {});
  r.need(entries.length > 0, "a stablecoin split needs at least one coin");
  for (const [asset, pct] of entries) {
    r.need(registry[asset]?.class === "stable", `${asset} isn't a stablecoin in the registry`);
    r.need(isPct(pct), `${asset}'s share must be above 0 and at most 100`);
  }
  r.need(Math.abs(entries.reduce((s, [, p]) => s + (isNum(p) ? p : 0), 0) - 100) < 1e-9, "the split must add to 100");
  return r.problems;
}

/** One coin's peg level: within `l2` of its peg is 0, then 2, and at `l3` or more (or unpriced) 3. */
export function pegLevel(price: number | null, pegUsd: number, depegPct: StableLimits["depegPct"]): 0 | 2 | 3 {
  if (!isPositive(price) || !isPositive(pegUsd)) return 3;
  const off = (Math.abs(price - pegUsd) / pegUsd) * 100;
  return off >= depegPct.l3 * (1 - 1e-12) ? 3 : off >= depegPct.l2 * (1 - 1e-12) ? 2 : 0;
}

/**
 * The moves for the stablecoins held. A coin off its peg (level 2 or more) is moved, as far as one move allows, into the
 * coins on peg, split between them by their targets: its target is 0 until it's back. With every coin on peg, the most
 * overweight coin is moved into the most underweight one once both are `driftPoints` off target. A coin with no usable
 * price can't be sized, so it isn't moved; with no coin on peg there is nowhere safe to move to, so nothing is. Every
 * move is at most `maxMoveUsd` and only between proposal assets; any other is listed as blocked.
 */
export function planStableMoves(holdings: readonly StableHolding[], split: StableSplit, limits: StableLimits = STABLE_DEFAULTS,
  registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): StablePlan | { problems: string[] } {
  const r = report();
  for (const p of splitProblems(split, registry)) r.need(false, p);
  r.need(isPct(limits.depegPct.l2) && isPct(limits.depegPct.l3) && limits.depegPct.l3 >= limits.depegPct.l2, "depeg thresholds must be above 0, rising and at most 100");
  r.need(isPositive(limits.driftPoints) && limits.driftPoints <= 100 && isPositive(limits.maxMoveUsd), "drift and move limits must be above zero");
  for (const h of holdings) r.need(registry[h.asset]?.class === "stable" && isNum(h.usd) && h.usd >= 0, `${h.asset}: not a stablecoin holding with a usable value`);
  if (r.problems.length > 0) return { problems: r.problems };

  const coins = [...new Set([...Object.keys(split), ...holdings.map(h => h.asset)])];
  const held = (asset: string) => holdings.find(h => h.asset === asset);
  const peg: Record<string, Level> = Object.fromEntries(coins.map(c => [c, pegLevel(held(c)?.price ?? null, registry[c]!.pegUsd!, limits.depegPct)]));
  // A coin can be moved into if it's on peg, a target of the split, and tradable.
  const healthy = coins.filter(c => peg[c] === 0 && (split[c] ?? 0) > 0);
  const moves: StableMove[] = [], blocked: StablePlan["blocked"] = [];
  const tradable = (c: string) => proposable(registry[c]!);
  const move = (kind: StableMove["kind"], from: string, to: string, sizeUsd: number, reason: string) => {
    const wanted: StableMove = { kind, from, to, sizeUsd: Math.min(sizeUsd, limits.maxMoveUsd), reason };
    for (const c of [from, to]) if (!tradable(c)) { blocked.push({ asset: c, reason: `${c} isn't among the platform's proposal assets: ${reason}`, move: wanted }); return; }
    moves.push(wanted);
  };

  const depegged = coins.filter(c => peg[c]! >= 2 && (held(c)?.usd ?? 0) > 0 && isPositive(held(c)?.price ?? null));
  if (depegged.length > 0) {
    if (healthy.length === 0) return { peg, moves, blocked: depegged.map(c => ({ asset: c, reason: "off its peg, and no other stablecoin is on peg to move into" })) };
    const weight = healthy.reduce((s, c) => s + split[c]!, 0);
    for (const c of depegged) {
      const usd = held(c)!.usd;
      for (const to of healthy) move("depeg-exit", c, to, (usd * split[to]!) / weight, `${c} is off its peg (L${peg[c]}): moved into the coins on peg`);
    }
    return { peg, moves, blocked };
  }

  const total = holdings.reduce((s, h) => s + h.usd, 0);
  if (!(total > 0)) return { peg, moves, blocked };
  const gap = (c: string) => ((held(c)?.usd ?? 0) / total) * 100 - (split[c] ?? 0);
  // Out of a priced coin, into one on peg: a coin with no price is neither sized nor bought.
  const over = coins.filter(c => isPositive(held(c)?.price ?? null)).sort((a, b) => gap(b) - gap(a))[0];
  const under = [...healthy].sort((a, b) => gap(a) - gap(b))[0];
  if (over !== undefined && under !== undefined && over !== under && gap(over) >= limits.driftPoints && -gap(under) >= limits.driftPoints)
    move("rebalance", over, under, (Math.min(gap(over), -gap(under)) * total) / 100, `${over} is ${gap(over).toFixed(1)} points over its share, ${under} ${(-gap(under)).toFixed(1)} under`);
  return { peg, moves, blocked };
}
