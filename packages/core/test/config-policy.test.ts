import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import type { Intent } from "../src/bands.ts";
import { checkLimits, POLICY_DEFAULTS, policyLimitProblems, type PolicyContext } from "../src/policy.ts";

const order: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 10_000, dcaUnits: 1, reason: "", at: 1 };
const ctx: PolicyContext = { treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10 };

test("the default policy limits are valid", () => assert.deepEqual(policyLimitProblems(POLICY_DEFAULTS), []));

test("unusable policy limits reject instead of switching a limit off", () => {
  for (const change of [{ maxOrderPctOfTreasury: NaNv }, { maxOrderPctOfTreasury: 0 }, { maxDailyTurnoverPct: NaNv }, { maxDailyTurnoverPct: 500 },
    { maxOrdersPerHour: NaNv }, { maxOrdersPerHour: 0 }, { maxOrdersPerHour: 2.5 }, { maxSlippageBps: NaNv }, { maxSlippageBps: -1 }]) {
    const r = checkLimits(order, ctx, { ...POLICY_DEFAULTS, ...change });
    assert.equal(r.ok === false && r.rule, "INVALID_INPUT", JSON.stringify(change));
  }
});
