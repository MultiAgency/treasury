// Policy engine, step 2 (A5.2): venue exposure and the protected operating cash. Pure; fails closed.
// Like the limit rules, this only adds to the platform's signed owner policy. Per the review on #72: the monthly spend
// rate is user-defined (set in the limits, no default), cash means stablecoins and every other asset is a risk asset.
// What a "venue" is and any valuation haircut on the cash are still for H6 to define.

import type { Proposal } from "./bands.ts";
import type { PolicyResult, PolicyRule } from "./policy.ts";
import { isNonNegative, isPct, isPositive, report } from "./validate.ts";

export const EXPOSURE_DEFAULTS = {
  /** One venue may hold at most this percent of the treasury. */
  maxVenueExposurePct: 25,
  /** Operating cash that is protected, in months of spend. The six-month floor wins over the three-month withdrawal buffer. */
  operatingCashMonths: 6,
} as const;

/** `monthlySpendUsd` is set by the user; it has no default, so an unset rate rejects instead of switching the floor off. */
export type ExposureLimits = { maxVenueExposurePct: number; operatingCashMonths: number; monthlySpendUsd: number | null };

/** What the policy can run with before the user has set a spend rate: every buy rejects until they do. */
export const EXPOSURE_CONFIG_DEFAULTS: ExposureLimits = { ...EXPOSURE_DEFAULTS, monthlySpendUsd: null };

/** A holding by symbol, valued in USD. */
export type Holding = { symbol: string; usd: number };

/**
 * Splits holdings into operating cash (stablecoins) and risk assets (everything else). `stablecoins` is the user's list;
 * symbols are compared ignoring case and surrounding spaces. Unusable values (NaN, negative) are returned as `null`
 * so the caller rejects rather than guessing.
 */
export function splitHoldings(holdings: readonly Holding[], stablecoins: readonly string[]): { cashUsd: number; riskAssetsUsd: number } | null {
  const stable = new Set(stablecoins.map(s => s.trim().toLowerCase()));
  let cashUsd = 0, riskAssetsUsd = 0;
  for (const h of holdings) {
    if (!Number.isFinite(h.usd) || h.usd < 0) return null;
    if (stable.has(h.symbol.trim().toLowerCase())) cashUsd += h.usd; else riskAssetsUsd += h.usd;
  }
  return { cashUsd, riskAssetsUsd };
}

export type ExposureContext = {
  treasuryValueUsd: number;
  /** USD already held at the order's venue. */
  venueExposureUsd: number;
  /** Operating cash held, in USD: stablecoins only (see `splitHoldings`). */
  cashUsd: number;
  /** USD of operating cash this order would use; 0 for a trade funded from the reserve. */
  spendsCashUsd: number;
};

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

/** What is wrong with the limits, if anything. A zero-month floor would switch the floor off, so it is refused. */
export function exposureProblems(l: ExposureLimits): string[] {
  const r = report();
  r.need(isPct(l.maxVenueExposurePct), "maxVenueExposurePct must be above 0 and at most 100");
  r.need(isPositive(l.operatingCashMonths), "operatingCashMonths must be above zero");
  r.need(l.monthlySpendUsd === null || isNonNegative(l.monthlySpendUsd), "monthlySpendUsd must be zero or more, or unset");
  return r.problems;
}
const reject = (failures: [PolicyRule, string][]): PolicyResult => {
  const first = failures[0];
  return first === undefined ? { ok: true } : { ok: false, rule: first[0], detail: failures.map(f => f[1]).join("; "), failed: failures.map(f => f[0]) };
};

/**
 * Venue exposure and cash floor for one order. A hold passes. A buy adds to the venue's exposure; a sell doesn't.
 * No buy while operating cash is under the floor, and no order may use cash if that leaves less than the floor.
 * Unknown or unusable numbers reject as `INVALID_INPUT`.
 */
export function checkExposure(order: Proposal, ctx: ExposureContext, limits: ExposureLimits = EXPOSURE_CONFIG_DEFAULTS): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const invalid = (detail: string) => reject([["INVALID_INPUT", detail]]);
  const badLimits = exposureProblems(limits);
  if (badLimits.length > 0) return invalid(`invalid limits: ${badLimits.join("; ")}`);
  if (!finite(order.sizeUsd) || order.sizeUsd <= 0) return invalid("order size must be above zero");
  if (!finite(ctx.treasuryValueUsd) || ctx.treasuryValueUsd <= 0) return invalid("no usable treasury value");
  if (!finite(ctx.venueExposureUsd) || ctx.venueExposureUsd < 0) return invalid("no usable venue exposure");
  if (!finite(ctx.cashUsd) || ctx.cashUsd < 0) return invalid("no usable cash balance");
  if (!finite(limits.monthlySpendUsd)) return invalid("spend rate not set: the user must define it before the cash floor can be checked");
  if (!finite(ctx.spendsCashUsd) || ctx.spendsCashUsd < 0) return invalid("no usable cash use");

  const failures: [PolicyRule, string][] = [];
  if (order.action === "buy-volatile" && (ctx.venueExposureUsd + order.sizeUsd) * 100 > limits.maxVenueExposurePct * ctx.treasuryValueUsd)
    failures.push(["VENUE_EXPOSURE", `venue would hold over ${limits.maxVenueExposurePct}% of the treasury`]);

  const floor = limits.monthlySpendUsd * limits.operatingCashMonths;
  if (order.action === "buy-volatile" && ctx.cashUsd < floor)
    failures.push(["CASH_FLOOR", `operating cash ${ctx.cashUsd} is under the ${limits.operatingCashMonths}-month floor ${floor}: no new risk`]);
  else if (ctx.spendsCashUsd > 0 && ctx.cashUsd - ctx.spendsCashUsd < floor)
    failures.push(["CASH_FLOOR", `using ${ctx.spendsCashUsd} of cash would leave less than the ${limits.operatingCashMonths}-month floor ${floor}`]);
  return reject(failures);
}
