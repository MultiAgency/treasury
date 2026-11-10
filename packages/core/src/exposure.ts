// Policy engine, step 2 (A5.2): venue exposure and the protected operating cash. Pure; fails closed.
// Like the limit rules, this only adds to the platform's signed owner policy. Per the review on #72: the monthly spend
// rate is user-defined (set in the limits, no default), cash means stablecoins and every other asset is a risk asset.
// H6 (ADR 3): a venue is where the agent's assets are held and settle, which today is its one NEAR Intents account, so
// the venue cap is the profile's volatile ceiling (`volatileMaxPct`) until a second venue exists. No haircut on cash.

import { ASSET_REGISTRY, isRisk, proposable, VENUES, type AssetClass, type AssetEntry } from "./assets.ts";
import type { Intent } from "./bands.ts";
import { RULE_ORDER, type PolicyResult, type PolicyRule } from "./policy.ts";
import { isNum, isPct, isPositive, report } from "./validate.ts";

export const EXPOSURE_DEFAULTS = {
  /** One venue may hold at most this percent of the treasury in risk assets: the balanced profile's volatile ceiling (H6, ADR 3). */
  maxVenueExposurePct: 50,
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


/**
 * What is wrong with the limits, if anything. A zero-month floor, or a spend of zero, would switch the floor off, so
 * both are refused. An unset spend is refused by the check itself, which can't run without it.
 */
export function exposureProblems(l: ExposureLimits): string[] {
  const r = report();
  r.need(isPct(l.maxVenueExposurePct), "maxVenueExposurePct must be above 0 and at most 100");
  r.need(isPositive(l.operatingCashMonths), "operatingCashMonths must be above zero");
  r.need(l.monthlySpendUsd === null || isPositive(l.monthlySpendUsd), "monthlySpendUsd must be above zero, or unset");
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
export function checkExposure(order: Intent, ctx: ExposureContext, limits: ExposureLimits = EXPOSURE_CONFIG_DEFAULTS): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const invalid = (detail: string) => reject([["INVALID_INPUT", detail]]);
  const badLimits = exposureProblems(limits);
  if (badLimits.length > 0) return invalid(`invalid limits: ${badLimits.join("; ")}`);
  if (!isNum(order.sizeUsd) || order.sizeUsd <= 0) return invalid("order size must be above zero");
  if (!isNum(ctx.treasuryValueUsd) || ctx.treasuryValueUsd <= 0) return invalid("no usable treasury value");
  if (!isNum(ctx.venueExposureUsd) || ctx.venueExposureUsd < 0) return invalid("no usable venue exposure");
  if (!isNum(ctx.cashUsd) || ctx.cashUsd < 0) return invalid("no usable cash balance");
  if (!isNum(limits.monthlySpendUsd)) return invalid("spend rate not set: the user must define it before the cash floor can be checked");
  if (!isNum(ctx.spendsCashUsd) || ctx.spendsCashUsd < 0) return invalid("no usable cash use");

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

// Per venue (#221): the diversified book's venue and class exposure. H6 counted one venue, the agent's NEAR
// Intents account, capped at the profile's volatile ceiling (`checkExposure`'s `VENUE_EXPOSURE`). With assets from other
// chains, each bridge an asset arrived through is a venue too: a holding counts at every venue on its path, so ETH counts
// at the account and at the Ethereum bridge. What counts where:
// - at the account, risk assets only (stablecoins are cash there, as H6 keeps them, with no haircut);
// - at a bridge, everything that crossed it, stablecoins included: a bridged stablecoin is only as good as its bridge.
// Each class has its own cap too, and each asset its liquidity limit (`ORDER_SIZE`). Like every check in this package,
// this only holds back; the platform's signed policy still has the last word.
//
// The context is computed once from the registry (`bookContext`) and then checked on its own, so a decision record
// carries everything the check read and replays without the registry.

/** A holding by registry symbol, valued in USD. */
export type ValuedHolding = { asset: string; usd: number };

/** What the book check reads: the order's asset as the registry describes it, and the book's exposure now. */
export type BookExposureContext = {
  treasuryValueUsd: number;
  asset: { symbol: string; class: AssetClass; venues: readonly string[]; proposable: boolean; maxOrderUsd: number };
  /** USD counted at each venue, and in each class, before this order. */
  venueUsd: Readonly<Record<string, number>>;
  classUsd: Readonly<Partial<Record<AssetClass, number>>>;
};

/** Caps in percent of the treasury: per venue (every venue on a traded asset's path needs one) and per class. */
export type BookExposureLimits = { venueCapsPct: Readonly<Record<string, number>>; classCapsPct: Readonly<Partial<Record<AssetClass, number>>> };

/** What is wrong with the limits, if anything. A class left out is capped at nothing; a venue left out refuses (below). */
export function bookLimitProblems(l: BookExposureLimits): string[] {
  const r = report();
  for (const [venue, pct] of Object.entries(l.venueCapsPct ?? {})) {
    r.need(VENUES[venue] !== undefined, `venue cap for unknown venue ${venue}`);
    r.need(isPct(pct), `the ${venue} cap must be above 0 and at most 100`);
  }
  for (const [cls, pct] of Object.entries(l.classCapsPct ?? {})) r.need(isNum(pct) && pct >= 0 && pct <= 100, `the ${cls} class cap must be 0 to 100`);
  return r.problems;
}

/** USD at each venue and in each class, from the holdings; null when one is unusable or not in the registry. */
export function bookExposure(holdings: readonly ValuedHolding[], registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY):
  { venueUsd: Record<string, number>; classUsd: Partial<Record<AssetClass, number>> } | null {
  const venueUsd: Record<string, number> = {}, classUsd: Partial<Record<AssetClass, number>> = {};
  for (const h of holdings) {
    const entry = registry[h.asset];
    if (!entry || !Number.isFinite(h.usd) || h.usd < 0) return null;
    classUsd[entry.class] = (classUsd[entry.class] ?? 0) + h.usd;
    entry.venues.forEach((venue, i) => {
      // The account counts risk only; a bridge counts everything that crossed it.
      if (i === 0 && !isRisk(entry)) return;
      venueUsd[venue] = (venueUsd[venue] ?? 0) + h.usd;
    });
  }
  return { venueUsd, classUsd };
}

/** The check's context for an order in `asset`, or null when the asset or a holding isn't in the registry or is unusable. */
export function bookContext(asset: string, holdings: readonly ValuedHolding[], treasuryValueUsd: number,
  registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): BookExposureContext | null {
  const entry = registry[asset];
  const exposure = bookExposure(holdings, registry);
  if (!entry || !exposure) return null;
  return {
    treasuryValueUsd,
    asset: { symbol: entry.symbol, class: entry.class, venues: [...entry.venues], proposable: proposable(entry), maxOrderUsd: entry.liquidity.maxOrderUsd },
    ...exposure,
  };
}

/** Results combined as `checkPolicy` combines its own: any rejection wins, listing every rule in order; then needs-approval. */
export function combineResults(results: readonly PolicyResult[]): PolicyResult {
  const failed = new Set<PolicyRule>(), details: string[] = [];
  for (const r of results) if (r.ok === false) { r.failed.forEach(f => failed.add(f)); details.push(r.detail); }
  if (failed.size > 0) {
    const ordered = RULE_ORDER.filter(rule => failed.has(rule));
    return { ok: false, rule: ordered[0]!, detail: details.join("; "), failed: ordered };
  }
  return results.find(r => r.ok === "needs-approval") ?? { ok: true };
}

/**
 * The diversified book's own rules for one order: the asset must be a proposal asset, the order within its liquidity
 * limit, and a buy must leave every venue on its path and its class within their caps. A sell only lowers exposure, so
 * only the first two apply to it. A hold passes; unusable numbers, or a venue on the path with no cap, are invalid input.
 */
export function checkBookExposure(order: Intent, ctx: BookExposureContext, limits: BookExposureLimits): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const invalid = (detail: string): PolicyResult => ({ ok: false, rule: "INVALID_INPUT", detail, failed: ["INVALID_INPUT"] });
  const bad = bookLimitProblems(limits);
  if (bad.length > 0) return invalid(`invalid book limits: ${bad.join("; ")}`);
  if (!isNum(order.sizeUsd) || order.sizeUsd <= 0) return invalid("order size must be above zero");
  if (!isNum(ctx.treasuryValueUsd) || ctx.treasuryValueUsd <= 0) return invalid("no usable treasury value");
  if (!ctx.asset.proposable) return invalid(`${ctx.asset.symbol} isn't among the platform's proposal assets`);
  const failures: [PolicyRule, string][] = [];
  if (!(order.sizeUsd <= ctx.asset.maxOrderUsd)) failures.push(["ORDER_SIZE", `order ${order.sizeUsd} USD is over ${ctx.asset.symbol}'s liquidity limit of ${ctx.asset.maxOrderUsd} USD`]);
  if (order.action === "buy-volatile") {
    for (const venue of ctx.asset.venues) {
      const cap = limits.venueCapsPct[venue];
      const held = ctx.venueUsd[venue] ?? 0;
      if (cap === undefined) return invalid(`no cap set for venue ${venue}`);
      if (!isNum(held) || held < 0) return invalid(`no usable exposure at ${venue}`);
      if ((held + order.sizeUsd) * 100 > cap * ctx.treasuryValueUsd)
        failures.push(["VENUE_EXPOSURE", `${VENUES[venue]?.label ?? venue} would hold over ${cap}% of the treasury`]);
    }
    const cap = limits.classCapsPct[ctx.asset.class] ?? 0, held = ctx.classUsd[ctx.asset.class] ?? 0;
    if (!isNum(held) || held < 0) return invalid(`no usable ${ctx.asset.class} exposure`);
    if ((held + order.sizeUsd) * 100 > cap * ctx.treasuryValueUsd)
      failures.push(["CLASS_EXPOSURE", `${ctx.asset.class} assets would be over ${cap}% of the treasury`]);
  }
  return combineResults(failures.map(([rule, detail]) => ({ ok: false, rule, detail, failed: [rule] })));
}
