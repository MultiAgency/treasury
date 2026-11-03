// Policy engine, step 3 (A5.3): escalation-level gating. Pure; fails closed.
// L0 acts within the mandate. L1 has reduced authority, L2 needs a human, L3 is stricter, L4 stops new sends.
// The plan doesn't specify what L1 and L3 restrict (H11), so these are the most conservative readings, as named defaults:
// L1 halves the per-order cap; L3 allows only risk-reducing sells, and they need approval too.

import type { Proposal } from "./bands.ts";
import type { PolicyResult } from "./policy.ts";

/** Escalation level. Rises on its own; only a human lowers it, one step at a time (A15). */
export type Level = 0 | 1 | 2 | 3 | 4;

export const LEVEL_DEFAULTS = {
  /** At L1, an order may be at most this fraction of the normal per-order cap. */
  l1OrderCapFactor: 0.5,
} as const;

export type LevelLimits = { l1OrderCapFactor: number; maxOrderPctOfTreasury: number };

export const isLevel = (n: unknown): n is Level => n === 0 || n === 1 || n === 2 || n === 3 || n === 4;

/** The level's effect on one order: pass, reject (rule `LEVEL`), or needs-approval. A hold always passes. */
export function checkLevel(order: Proposal, level: Level, treasuryValueUsd: number, limits: LevelLimits): PolicyResult {
  if (order.action === "hold") return { ok: true };
  const reject = (detail: string): PolicyResult => ({ ok: false, rule: "LEVEL", detail, failed: ["LEVEL"] });
  if (!isLevel(level)) return { ok: false, rule: "INVALID_INPUT", detail: "unknown escalation level", failed: ["INVALID_INPUT"] };
  switch (level) {
    case 0:
      return { ok: true };
    case 1: {
      if (!Number.isFinite(treasuryValueUsd) || treasuryValueUsd <= 0) return { ok: false, rule: "INVALID_INPUT", detail: "no usable treasury value", failed: ["INVALID_INPUT"] };
      const cap = limits.l1OrderCapFactor * limits.maxOrderPctOfTreasury;
      return order.sizeUsd * 100 > cap * treasuryValueUsd ? reject(`L1: orders are limited to ${cap}% of the treasury`) : { ok: true };
    }
    case 2:
      return { ok: "needs-approval", reason: "L2: a human must approve this order" };
    case 3:
      return order.action === "sell-volatile" ? { ok: "needs-approval", reason: "L3: only risk-reducing sells, each approved by a human" } : reject("L3: no new buys");
    case 4:
      return reject("L4: red hand, no new sends");
  }
}
