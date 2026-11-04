// The per-order cap is one rule, applied by sizing and checked by the policy: an order sized to exactly the cap must
// pass the policy's check of it. Sizing computed total × pct / 100 and the policy compared size × 100 against
// pct × value, and floating point made the two disagree on about one total in fifteen (the review on #30, item 9).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Proposal } from "../src/bands.ts";
import { checkLimits, POLICY_DEFAULTS } from "../src/policy.ts";
import { SIZING_DEFAULTS, sizeProposal } from "../src/sizing.ts";

const buy: Proposal = { id: "p", zone: "dca-3", action: "buy-volatile", sizeUsd: 0, dcaUnits: 0, reason: "", at: 1 };

test("an order sizing caps at 2% passes the policy's 2% check, for every total sampled", () => {
  let seed = 42;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const rejected: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const total = Math.round(next() * 1e9) / 100;
    // All in reserve: dca-3 wants 6% of it, so the 2% cap is what sizes the order.
    const sized = sizeProposal(buy, { volatileUsd: 0, reserveUsd: total, cashUsd: 0 }, { volatileMinPct: 0, volatileMaxPct: 100 }, { dcaUnitsUsed: 0 });
    const r = checkLimits(sized, { treasuryValueUsd: total, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10 });
    if (r.ok === false && r.rule === "ORDER_SIZE") rejected.push(total);
  }
  assert.deepEqual(rejected.slice(0, 3), [], `${rejected.length} of 20000 capped orders rejected as over the cap`);
});

test("the cap is defined once: sizing's default is the policy's", () => {
  assert.equal(SIZING_DEFAULTS.maxOrderPctOfTreasury, POLICY_DEFAULTS.maxOrderPctOfTreasury);
});
