import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLimits, POLICY_DEFAULTS, type PolicyContext } from "../src/policy.ts";
import type { Intent } from "../src/bands.ts";

const order = (sizeUsd: number, action: Intent["action"] = "buy-volatile"): Intent =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
// A 1,000,000 USD treasury: 2% order = 20,000; 10% daily = 100,000.
const ctx: PolicyContext = { treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10 };
const rejected = (r: ReturnType<typeof checkLimits>) => (r.ok === false ? r : assert.fail("expected a rejection"));

test("a hold always passes, even with unusable inputs", () => {
  assert.deepEqual(checkLimits(order(0, "hold"), { ...ctx, treasuryValueUsd: Number.NaN }), { ok: true });
});

test("an order within every limit passes", () => {
  assert.deepEqual(checkLimits(order(10_000), ctx), { ok: true });
});

test("order size: exactly 2% passes, a cent over rejects", () => {
  assert.deepEqual(checkLimits(order(20_000), ctx), { ok: true });
  const r = rejected(checkLimits(order(20_000.01), ctx));
  assert.deepEqual([r.rule, r.failed], ["ORDER_SIZE", ["ORDER_SIZE"]]);
});

test("daily turnover: reaching exactly 10% passes, over rejects", () => {
  assert.deepEqual(checkLimits(order(10_000), { ...ctx, turnoverTodayUsd: 90_000 }), { ok: true });
  assert.equal(rejected(checkLimits(order(10_000), { ...ctx, turnoverTodayUsd: 90_000.01 })).rule, "DAILY_TURNOVER");
});

test("order rate: the tenth order in an hour passes, the eleventh rejects", () => {
  assert.deepEqual(checkLimits(order(1_000), { ...ctx, ordersLastHour: 9 }), { ok: true });
  assert.equal(rejected(checkLimits(order(1_000), { ...ctx, ordersLastHour: 10 })).rule, "ORDER_RATE");
});

test("slippage: exactly 50 bps passes, over rejects", () => {
  assert.deepEqual(checkLimits(order(1_000), { ...ctx, quotedSlippageBps: 50 }), { ok: true });
  assert.equal(rejected(checkLimits(order(1_000), { ...ctx, quotedSlippageBps: 50.01 })).rule, "SLIPPAGE");
});

test("several failures report the first rule in a fixed order and list them all", () => {
  const r = rejected(checkLimits(order(30_000), { ...ctx, turnoverTodayUsd: 95_000, ordersLastHour: 10, quotedSlippageBps: 80 }));
  assert.equal(r.rule, "ORDER_SIZE");
  assert.deepEqual(r.failed, ["ORDER_SIZE", "DAILY_TURNOVER", "ORDER_RATE", "SLIPPAGE"]);
});

test("missing or impossible inputs reject as invalid, evaluating nothing else", () => {
  const bad: [string, Partial<PolicyContext>][] = [
    ["no treasury value", { treasuryValueUsd: 0 }], ["NaN value", { treasuryValueUsd: Number.NaN }],
    ["negative turnover", { turnoverTodayUsd: -1 }], ["fractional orders", { ordersLastHour: 1.5 }],
    ["negative orders", { ordersLastHour: -1 }], ["no quote", { quotedSlippageBps: null }],
    ["negative slippage", { quotedSlippageBps: -1 }],
  ];
  for (const [name, change] of bad) {
    const r = rejected(checkLimits(order(1_000), { ...ctx, ...change }));
    assert.deepEqual([name, r.rule, r.failed], [name, "INVALID_INPUT", ["INVALID_INPUT"]]);
  }
  assert.equal(rejected(checkLimits(order(0), ctx)).rule, "INVALID_INPUT");
  assert.equal(rejected(checkLimits(order(Number.NaN), ctx)).rule, "INVALID_INPUT");
});

test("the limits can be changed", () => {
  assert.deepEqual(checkLimits(order(50_000), ctx, { ...POLICY_DEFAULTS, maxOrderPctOfTreasury: 5 }), { ok: true });
});

test("the same input always gives the same result", () => {
  assert.deepEqual(checkLimits(order(30_000), ctx), checkLimits(order(30_000), ctx));
});
