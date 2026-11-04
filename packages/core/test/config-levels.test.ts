import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import type { Intent } from "../src/bands.ts";
import { checkPolicy, POLICY_CONFIG_DEFAULTS, type FullContext } from "../src/check.ts";
import { EXPOSURE_CONFIG_DEFAULTS } from "../src/exposure.ts";
import { checkLevel, LEVEL_DEFAULTS, levelProblems } from "../src/levels.ts";
import { POLICY_DEFAULTS } from "../src/policy.ts";

const order: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 10_000, dcaUnits: 1, reason: "", at: 1 };
const ctx: FullContext = { treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10,
  venueExposureUsd: 100_000, cashUsd: 100_000, spendsCashUsd: 0, level: 0 };
const invalid = (r: ReturnType<typeof checkPolicy>) => r.ok === false && r.rule === "INVALID_INPUT";

test("the default level limits are valid", () => assert.deepEqual(levelProblems({ ...LEVEL_DEFAULTS, maxOrderPctOfTreasury: 2 }), []));

test("unusable level limits reject", () => {
  for (const change of [{ l1OrderCapFactor: NaNv }, { l1OrderCapFactor: 0 }, { l1OrderCapFactor: 2 }, { maxOrderPctOfTreasury: NaNv }]) {
    const r = checkLevel(order, 0, 1_000_000, { ...LEVEL_DEFAULTS, maxOrderPctOfTreasury: 2, ...change });
    assert.equal(r.ok === false && r.rule, "INVALID_INPUT", JSON.stringify(change));
  }
});

// A valid configuration (spend rate set), so each case below fails for its own bad value only.
const GOOD = { ...POLICY_CONFIG_DEFAULTS, exposure: { ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 10_000 } };

test("the whole policy check refuses a bad configuration anywhere in it", () => {
  assert.equal(invalid(checkPolicy(order, ctx, { ...GOOD, limits: { ...POLICY_DEFAULTS, maxSlippageBps: NaNv } })), true);
  assert.equal(invalid(checkPolicy(order, ctx, { ...GOOD, exposure: { ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 10_000, operatingCashMonths: 0 } })), true);
  assert.equal(invalid(checkPolicy(order, ctx, { ...GOOD, l1OrderCapFactor: NaNv })), true);
});
