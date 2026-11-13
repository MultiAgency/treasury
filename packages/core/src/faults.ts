// Edge-case detectors, data and system faults (A6.2): source disagreement, thin liquidity, venue outage, stablecoin
// depeg, cash floor breach and agent malfunction. Pure: everything is passed in. Each detection names an escalation
// level and the highest decides; `regimeFrom` maps any detection to a non-trading regime for A4.3. Every number is a
// named default awaiting H6/H9/H11 (the plan lists the cases but gives no thresholds). Fail closed: an observation that
// is missing or unusable is itself a detection, never silence.

import type { Detection as MarketDetection } from "./detectors.ts";
import { highestLevel } from "./detectors.ts";
import type { Level } from "./levels.ts";
import type { FrozenReason } from "./oracle.ts";
import type { Regime } from "./whipsaw.ts";
import { isNonNegative, isPct, isPositive, report } from "./validate.ts";

export const FAULT_DEFAULTS = {
  /** Quoted slippage for a reference order at or above this is thin liquidity (L1); at or above `thinL2Bps`, L2. No usable quote is L2: unknown ranks as the worst case. */
  thinLiquidityBps: { l1: 100, l2: 300 },
  /** A stablecoin this far from $1 is a depeg: L2 at `l2`, L3 at `l3`, in percent. No usable price is L3: unknown ranks as the worst case. */
  depegPct: { l2: 1, l3: 3 },
  /** Holdings off the records by more than this percent of the book are a reconciliation mismatch (L3). */
  reconciliationMismatchPct: 0.1,
} as const;

export type FaultConfig = {
  thinLiquidityBps: { l1: number; l2: number };
  depegPct: { l2: number; l3: number };
  reconciliationMismatchPct: number;
};

/** What the detectors look at. `null` means "could not be observed", which counts as a fault. */
export type FaultObservations = {
  /** The frozen reason of the latest oracle reading, or null when it was not frozen. */
  oracleFrozen: FrozenReason | "warming-up" | null;
  /** Quoted slippage in basis points for a reference order, or null when there is no fresh quote. */
  quotedSlippageBps: number | null;
  /** Whether the venue answered its last health check; null when unknown. */
  venueUp: boolean | null;
  /** USD price of each stablecoin held; a missing or unusable price is a fault. */
  stablecoinPrices: Readonly<Record<string, number | null>>;
  /** Operating cash and its floor, both in USD (see `checkExposure`). */
  cashUsd: number | null;
  cashFloorUsd: number | null;
  /** Operations whose outcome is unknown (submitted, no result). */
  unknownOutcomes: number | null;
  /** The book's value, and how far its holdings are off the records (`unreconciledUsd`), both in USD. */
  bookUsd: number | null;
  unreconciledUsd: number | null;
};

export type FaultName =
  | "faults-config" | "source-disagreement" | "source-unavailable" | "thin-liquidity" | "venue-outage"
  | "stablecoin-depeg" | "cash-floor-breach" | "agent-malfunction";
export type FaultDetection = { detector: FaultName; level: Level; reason: string };

/** Each threshold rule's check, with the highest level its detector can give: an unusable rule ranks as that. */
function thresholdRules(c: FaultConfig) {
  const t = c.thinLiquidityBps, d = c.depegPct;
  return {
    thin: { ok: isPositive(t.l1) && isPositive(t.l2) && t.l2 >= t.l1 && t.l2 <= 10_000, worst: 2 as Level, message: "thin-liquidity thresholds must be above zero, rising and at most 10000 bps" },
    depeg: { ok: isPct(d.l2) && isPct(d.l3) && d.l3 >= d.l2, worst: 3 as Level, message: "depeg thresholds must be above 0, rising and at most 100" },
    reconciliation: { ok: isNonNegative(c.reconciliationMismatchPct) && c.reconciliationMismatchPct <= 100, worst: 3 as Level, message: "reconciliationMismatchPct must be 0 to 100" },
  };
}

/** What is wrong with the thresholds, if anything. */
export function faultProblems(c: FaultConfig): string[] {
  const r = report();
  for (const rule of Object.values(thresholdRules(c))) r.need(rule.ok, rule.message);
  return r.problems;
}

const num = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Detections of data and system faults. An empty list is normal. Trigger values exactly at a threshold count. A rule
 * with unusable thresholds is replaced by a `faults-config` detection at its worst level; the others still run.
 */
export function detectFaults(obs: FaultObservations, cfg: FaultConfig = FAULT_DEFAULTS): FaultDetection[] {
  const found: FaultDetection[] = [];
  const add = (detector: FaultName, level: Level, reason: string) => { found.push({ detector, level, reason }); };
  const rules = thresholdRules(cfg);
  for (const rule of Object.values(rules)) if (!rule.ok) add("faults-config", rule.worst, `invalid fault configuration: ${rule.message}`);

  if (obs.oracleFrozen === "disagreement") add("source-disagreement", 2, "price sources disagree: the oracle is frozen");
  else if (obs.oracleFrozen !== null) add("source-unavailable", 1, `the oracle is frozen (${obs.oracleFrozen})`);

  if (rules.thin.ok) {
    if (!num(obs.quotedSlippageBps) || obs.quotedSlippageBps < 0) add("thin-liquidity", 2, "no usable quote: liquidity unknown");
    else if (obs.quotedSlippageBps >= cfg.thinLiquidityBps.l2) add("thin-liquidity", 2, `slippage ${obs.quotedSlippageBps} bps is ${cfg.thinLiquidityBps.l2} or more`);
    else if (obs.quotedSlippageBps >= cfg.thinLiquidityBps.l1) add("thin-liquidity", 1, `slippage ${obs.quotedSlippageBps} bps is ${cfg.thinLiquidityBps.l1} or more`);
  }

  if (obs.venueUp !== true) add("venue-outage", 2, obs.venueUp === false ? "the venue is down" : "venue status unknown");

  if (rules.depeg.ok) {
    // Cash is held in stablecoins and the floor is above zero, so no prices at all is no usable price.
    if (Object.keys(obs.stablecoinPrices).length === 0) add("stablecoin-depeg", 3, "no usable stablecoin price");
    for (const [coin, price] of Object.entries(obs.stablecoinPrices)) {
      if (!num(price) || price <= 0) { add("stablecoin-depeg", 3, `${coin}: no usable price`); continue; }
      const off = Math.abs(price - 1) * 100; // percent away from $1, compared as off >= pct (price is 1 ± a fraction)
      if (off >= cfg.depegPct.l3 * (1 - 1e-12)) add("stablecoin-depeg", 3, `${coin} is ${off.toFixed(2)}% from $1`);
      else if (off >= cfg.depegPct.l2 * (1 - 1e-12)) add("stablecoin-depeg", 2, `${coin} is ${off.toFixed(2)}% from $1`);
    }
  }

  // A zero floor would switch the check off (as in `exposureProblems`), so it counts as unknown.
  if (!num(obs.cashUsd) || !num(obs.cashFloorUsd) || obs.cashUsd < 0 || obs.cashFloorUsd <= 0) add("cash-floor-breach", 2, "cash or its floor is unknown");
  else if (obs.cashUsd < obs.cashFloorUsd) add("cash-floor-breach", 2, `cash ${obs.cashUsd} is under the floor ${obs.cashFloorUsd}`);

  if (!num(obs.unknownOutcomes) || obs.unknownOutcomes < 0) add("agent-malfunction", 3, "unknown-outcome count unavailable");
  else if (obs.unknownOutcomes > 0) add("agent-malfunction", 3, `${obs.unknownOutcomes} operation(s) with an unknown outcome`);
  if (rules.reconciliation.ok) {
    if (!num(obs.bookUsd) || !num(obs.unreconciledUsd) || obs.bookUsd <= 0 || obs.unreconciledUsd < 0) add("agent-malfunction", 3, "holdings can't be reconciled");
    else if (obs.unreconciledUsd * 100 > cfg.reconciliationMismatchPct * obs.bookUsd)
      add("agent-malfunction", 3, `holdings are off the records by more than ${cfg.reconciliationMismatchPct}% of the book`);
  }
  return found;
}

/** One asset of the platform's `reconcileBooks`: raw-unit differences, as decimal strings. */
export type BooksRow = { asset: string; public: { drift: string }; confidential: { unattributed: string } };
/** An asset's price and decimals, as the platform's `overview` reports them. */
export type PricedAsset = { asset: string; decimals: number | null; price: number | null };

/**
 * How far the holdings are off the records, in USD: each asset's public drift (the API's balance against the chain's
 * transfers) and confidential unattributed amount (the API's balance against its recorded executions), valued at its
 * price. Differences are summed as sizes, so a shortfall in one asset never hides a surplus in another. Null when a
 * difference can't be read or valued: unknown, which the detector ranks as the worst case.
 */
export function unreconciledUsd(rows: readonly BooksRow[], prices: readonly PricedAsset[]): number | null {
  let total = 0;
  for (const row of rows) {
    const amounts = [row.public?.drift, row.confidential?.unattributed];
    if (!amounts.every(v => typeof v === "string" && /^-?\d+$/.test(v))) return null;
    const raw = amounts.reduce((sum, v) => { const n = BigInt(v); return sum + (n < 0n ? -n : n); }, 0n);
    if (raw === 0n) continue;
    const p = prices.find(x => x.asset === row.asset);
    if (!p || !num(p.price) || p.price <= 0 || !Number.isInteger(p.decimals) || p.decimals! < 0 || p.decimals! > 255) return null;
    total += Number(raw) / 10 ** p.decimals! * p.price;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

/** The highest level among fault detections (0 when there are none). */
export const highestFaultLevel = (found: readonly FaultDetection[]): Level => highestLevel(found as unknown as MarketDetection[]);

/**
 * The regime for A4.3 from any mix of market-move and fault detections: `normal` only when there are none. Source
 * problems give `source-stress`, thin liquidity `thin-liquidity`, market moves `fast-move`, and every other fault, or an
 * unusable configuration, `system-fault`: each holds every trade. The stabilization agent's forward detections (#220),
 * a projection that couldn't be made among them, give `forward-risk`, which holds buys only (ADR 5); any other
 * detection beside them names the regime first.
 */
export function regimeFrom(found: readonly { detector: string }[]): Regime {
  if (found.length === 0) return "normal";
  const names = new Set(found.map(d => d.detector));
  if (names.has("faults-config") || names.has("config") || names.has("risk-config")) return "system-fault";
  for (const n of ["source-disagreement", "source-unavailable", "history"]) if (names.has(n)) return "source-stress";
  if (names.has("thin-liquidity")) return "thin-liquidity";
  for (const n of ["fast-rise", "fast-drop", "crash", "parabolic", "sideways-chop"]) if (names.has(n)) return "fast-move";
  for (const n of ["projection", "projected-drawdown", "expected-shortfall", "floor-breach-probability", "runway", "stress"]) if (names.has(n)) return "forward-risk";
  return "system-fault";
}
