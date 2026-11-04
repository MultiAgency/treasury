// Policy engine, whole (A5): every rule for one order, and the re-check of an approval that may have gone stale.

import type { Intent } from "./bands.ts";
import { checkExposure, EXPOSURE_CONFIG_DEFAULTS, type ExposureContext, type ExposureLimits } from "./exposure.ts";
import { checkLevel, isLevel, LEVEL_DEFAULTS, type Level } from "./levels.ts";
import { checkLimits, POLICY_DEFAULTS, RULE_ORDER, type PolicyContext, type PolicyLimits, type PolicyResult, type PolicyRule } from "./policy.ts";

export type FullContext = PolicyContext & Omit<ExposureContext, "treasuryValueUsd"> & { level: Level };
export type PolicyConfig = { limits: PolicyLimits; exposure: ExposureLimits; l1OrderCapFactor: number };
export const POLICY_CONFIG_DEFAULTS: PolicyConfig = { limits: POLICY_DEFAULTS, exposure: EXPOSURE_CONFIG_DEFAULTS, l1OrderCapFactor: LEVEL_DEFAULTS.l1OrderCapFactor };

/**
 * Runs every rule. Any rejection wins: the result names the first failing rule in `RULE_ORDER` and lists them all.
 * Otherwise, if the level calls for a human, needs-approval; otherwise ok. A hold always passes.
 */
export function checkPolicy(order: Intent, ctx: FullContext, config: PolicyConfig = POLICY_CONFIG_DEFAULTS): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const results = [
    checkLimits(order, ctx, config.limits),
    checkExposure(order, ctx, config.exposure),
    checkLevel(order, ctx.level, ctx.treasuryValueUsd, { l1OrderCapFactor: config.l1OrderCapFactor, maxOrderPctOfTreasury: config.limits.maxOrderPctOfTreasury }),
  ];
  const failed = new Set<PolicyRule>();
  const details: string[] = [];
  for (const r of results) if (r.ok === false) { r.failed.forEach(f => failed.add(f)); details.push(r.detail); }
  if (failed.size > 0) {
    const ordered = RULE_ORDER.filter(r => failed.has(r));
    return { ok: false, rule: ordered[0]!, detail: details.join("; "), failed: ordered };
  }
  const approval = results.find(r => r.ok === "needs-approval");
  return approval ?? { ok: true };
}

/**
 * What an approval was given under, and the order it was given for. The order's id, direction and size are part of it:
 * a human approved that order, so an approval can't be spent on a different or a larger one.
 */
export type Approval = {
  level: Level;
  mandateDigest: string;
  quoteExpiresAt: number;
  orderId: string;
  action: Exclude<Intent["action"], "hold">;
  sizeUsd: number;
};

/**
 * Re-checks an approved order just before it runs. The approval is void if it is malformed, was given for another
 * order, the mandate changed, the level has risen since, or the quote has expired; otherwise every rule is checked
 * again with the current numbers, and needs-approval counts as satisfied (the human already approved). Returns ok or
 * the rejection.
 */
export function recheckApproval(order: Intent, ctx: FullContext, approval: Approval, currentMandateDigest: string, now: number,
  config: PolicyConfig = POLICY_CONFIG_DEFAULTS): PolicyResult {
  const stale = (detail: string): PolicyResult => ({ ok: false, rule: "STALE_APPROVAL", detail, failed: ["STALE_APPROVAL"] });
  // A malformed approval would make "the level rose" or "the quote expired" read false, so it rejects before them.
  if (!isLevel(approval.level)) return stale("the approval has no valid level");
  if (typeof approval.mandateDigest !== "string" || approval.mandateDigest === "") return stale("the approval has no mandate digest");
  if (typeof approval.orderId !== "string" || approval.orderId === "") return stale("the approval names no order");
  if (!Number.isFinite(approval.sizeUsd) || approval.sizeUsd <= 0) return stale("the approval has no usable size");
  if (!Number.isFinite(approval.quoteExpiresAt)) return stale("the approval has no usable quote expiry");
  if (approval.orderId !== order.id || approval.action !== order.action || approval.sizeUsd !== order.sizeUsd)
    return stale(`the approval was given for ${approval.orderId} (${approval.action} ${approval.sizeUsd}), not ${order.id} (${order.action} ${order.sizeUsd})`);
  if (approval.mandateDigest !== currentMandateDigest) return stale("the mandate changed since the approval");
  if (!isLevel(ctx.level)) return stale("the current level is unknown");
  if (ctx.level > approval.level) return stale(`the level rose from L${approval.level} to L${ctx.level} since the approval`);
  if (!Number.isFinite(now) || !(now <= approval.quoteExpiresAt)) return stale("the quote has expired");
  const current = checkPolicy(order, ctx, config);
  return current.ok === "needs-approval" ? { ok: true } : current;
}
