// Policy engine, step 1 (A5.1): the result type and the limit rules. Pure and deterministic; fails closed.
// Later steps add venue exposure and the cash floor (A5.2) and level gating (A5.3). This layer only adds to the
// platform's own signed owner policy: it can reject more, never allow what the platform refuses. Limits are the plan's
// defaults, awaiting H6's rules-to-policy map and H9's calibration.

import type { Proposal } from "./bands.ts";

export const POLICY_DEFAULTS = {
  /** One order, as a percent of the treasury value. */
  maxOrderPctOfTreasury: 2,
  /** Gross traded value in a rolling day, as a percent of the treasury value. */
  maxDailyTurnoverPct: 10,
  maxOrdersPerHour: 10,
  /** Quoted slippage against the oracle median, in basis points. */
  maxSlippageBps: 50,
} as const;

export type PolicyLimits = {
  maxOrderPctOfTreasury: number;
  maxDailyTurnoverPct: number;
  maxOrdersPerHour: number;
  maxSlippageBps: number;
};

export type PolicyRule = "INVALID_INPUT" | "ORDER_SIZE" | "DAILY_TURNOVER" | "ORDER_RATE" | "SLIPPAGE" | "VENUE_EXPOSURE" | "CASH_FLOOR";

/** The order rules are reported in: the first failing one is the result's `rule`. */
export const RULE_ORDER: readonly PolicyRule[] = ["INVALID_INPUT", "ORDER_SIZE", "DAILY_TURNOVER", "ORDER_RATE", "SLIPPAGE", "VENUE_EXPOSURE", "CASH_FLOOR"];

/** What the check needs. The treasury value is one snapshot taken when the order was proposed, never re-read mid-check. */
export type PolicyContext = {
  treasuryValueUsd: number;
  /** Gross USD traded in the rolling 24 hours before this order. */
  turnoverTodayUsd: number;
  /** Orders submitted in the last hour before this one. */
  ordersLastHour: number;
  /** Quoted slippage in basis points, or null when there is no fresh quote. */
  quotedSlippageBps: number | null;
};

export type PolicyResult =
  | { ok: true }
  /** `rule` is the first failing rule in a fixed order; `failed` lists every one that failed. */
  | { ok: false; rule: PolicyRule; detail: string; failed: PolicyRule[] }
  /** Used by level gating (A5.3). */
  | { ok: "needs-approval"; reason: string };

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

/**
 * Checks one order against the limits. A hold always passes. Missing, non-finite or impossible inputs reject as
 * `INVALID_INPUT` and nothing else is evaluated. A value exactly at a limit passes; only over it rejects.
 */
export function checkLimits(order: Proposal, ctx: PolicyContext, limits: PolicyLimits = POLICY_DEFAULTS): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const bad = (detail: string): PolicyResult => ({ ok: false, rule: "INVALID_INPUT", detail, failed: ["INVALID_INPUT"] });

  if (!finite(order.sizeUsd) || order.sizeUsd <= 0) return bad("order size must be above zero");
  if (!finite(ctx.treasuryValueUsd) || ctx.treasuryValueUsd <= 0) return bad("no usable treasury value");
  if (!finite(ctx.turnoverTodayUsd) || ctx.turnoverTodayUsd < 0) return bad("no usable turnover so far");
  if (!Number.isInteger(ctx.ordersLastHour) || ctx.ordersLastHour < 0) return bad("no usable order count");
  if (!finite(ctx.quotedSlippageBps) || ctx.quotedSlippageBps < 0) return bad("no fresh quote: slippage unknown");

  // Compared without dividing: size × 100 against percent × value, so a value exactly at the limit passes.
  const value = ctx.treasuryValueUsd;
  const failures: [PolicyRule, string][] = [];
  if (order.sizeUsd * 100 > limits.maxOrderPctOfTreasury * value)
    failures.push(["ORDER_SIZE", `order ${order.sizeUsd} USD is over ${limits.maxOrderPctOfTreasury}% of the treasury`]);
  if ((ctx.turnoverTodayUsd + order.sizeUsd) * 100 > limits.maxDailyTurnoverPct * value)
    failures.push(["DAILY_TURNOVER", `daily turnover would be over ${limits.maxDailyTurnoverPct}% of the treasury`]);
  if (ctx.ordersLastHour + 1 > limits.maxOrdersPerHour)
    failures.push(["ORDER_RATE", `${ctx.ordersLastHour} orders in the last hour; the limit is ${limits.maxOrdersPerHour}`]);
  if (ctx.quotedSlippageBps > limits.maxSlippageBps)
    failures.push(["SLIPPAGE", `quoted slippage ${ctx.quotedSlippageBps} bps is over ${limits.maxSlippageBps} bps`]);

  const first = failures[0];
  if (first === undefined) return { ok: true };
  return { ok: false, rule: first[0], detail: failures.map(f => f[1]).join("; "), failed: failures.map(f => f[0]) };
}
