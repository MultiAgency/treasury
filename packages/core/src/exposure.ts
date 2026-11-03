// Policy engine, step 2 (A5.2): venue exposure and the protected operating cash. Pure; fails closed.
// Like the limit rules, this only adds to the platform's signed owner policy. What a "venue" is, the spend-rate source
// and any valuation haircut on the cash are for H6 to define; until then the caller supplies the numbers.

import type { Proposal } from "./bands.ts";
import type { PolicyResult, PolicyRule } from "./policy.ts";

export const EXPOSURE_DEFAULTS = {
  /** One venue may hold at most this percent of the treasury. */
  maxVenueExposurePct: 25,
  /** Operating cash that is protected, in months of spend. The six-month floor wins over the three-month withdrawal buffer. */
  operatingCashMonths: 6,
} as const;

export type ExposureLimits = { maxVenueExposurePct: number; operatingCashMonths: number };

export type ExposureContext = {
  treasuryValueUsd: number;
  /** USD already held at the order's venue. */
  venueExposureUsd: number;
  /** Operating cash held, in USD. */
  cashUsd: number;
  /** Monthly operating spend in USD, or null when unknown (which rejects). */
  monthlySpendUsd: number | null;
  /** USD of operating cash this order would use; 0 for a trade funded from the reserve. */
  spendsCashUsd: number;
};

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
const reject = (failures: [PolicyRule, string][]): PolicyResult => {
  const first = failures[0];
  return first === undefined ? { ok: true } : { ok: false, rule: first[0], detail: failures.map(f => f[1]).join("; "), failed: failures.map(f => f[0]) };
};

/**
 * Venue exposure and cash floor for one order. A hold passes. A buy adds to the venue's exposure; a sell doesn't.
 * No buy while operating cash is under the floor, and no order may use cash if that leaves less than the floor.
 * Unknown or unusable numbers reject as `INVALID_INPUT`.
 */
export function checkExposure(order: Proposal, ctx: ExposureContext, limits: ExposureLimits = EXPOSURE_DEFAULTS): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const invalid = (detail: string) => reject([["INVALID_INPUT", detail]]);
  if (!finite(order.sizeUsd) || order.sizeUsd <= 0) return invalid("order size must be above zero");
  if (!finite(ctx.treasuryValueUsd) || ctx.treasuryValueUsd <= 0) return invalid("no usable treasury value");
  if (!finite(ctx.venueExposureUsd) || ctx.venueExposureUsd < 0) return invalid("no usable venue exposure");
  if (!finite(ctx.cashUsd) || ctx.cashUsd < 0) return invalid("no usable cash balance");
  if (!finite(ctx.monthlySpendUsd) || ctx.monthlySpendUsd < 0) return invalid("spend rate unknown: the cash floor can't be checked");
  if (!finite(ctx.spendsCashUsd) || ctx.spendsCashUsd < 0) return invalid("no usable cash use");

  const failures: [PolicyRule, string][] = [];
  if (order.action === "buy-volatile" && (ctx.venueExposureUsd + order.sizeUsd) * 100 > limits.maxVenueExposurePct * ctx.treasuryValueUsd)
    failures.push(["VENUE_EXPOSURE", `venue would hold over ${limits.maxVenueExposurePct}% of the treasury`]);

  const floor = ctx.monthlySpendUsd * limits.operatingCashMonths;
  if (order.action === "buy-volatile" && ctx.cashUsd < floor)
    failures.push(["CASH_FLOOR", `operating cash ${ctx.cashUsd} is under the ${limits.operatingCashMonths}-month floor ${floor}: no new risk`]);
  else if (ctx.spendsCashUsd > 0 && ctx.cashUsd - ctx.spendsCashUsd < floor)
    failures.push(["CASH_FLOOR", `using ${ctx.spendsCashUsd} of cash would leave less than the ${limits.operatingCashMonths}-month floor ${floor}`]);
  return reject(failures);
}
