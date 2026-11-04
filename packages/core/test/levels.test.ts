import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLevel, isLevel, LEVEL_DEFAULTS, type Level } from "../src/levels.ts";
import type { Proposal } from "../src/bands.ts";

const order = (sizeUsd: number, action: Proposal["action"] = "buy-volatile"): Proposal =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
const limits = { ...LEVEL_DEFAULTS, maxOrderPctOfTreasury: 2 };
const VALUE = 1_000_000;

test("a hold passes at every level", () => {
  for (const level of [0, 1, 2, 3, 4] as Level[]) assert.deepEqual(checkLevel(order(0, "hold"), level, VALUE, limits), { ok: true });
});

test("L0 passes", () => assert.deepEqual(checkLevel(order(20_000), 0, VALUE, limits), { ok: true }));

test("L1 halves the order cap: exactly 1% passes, over rejects", () => {
  assert.deepEqual(checkLevel(order(10_000), 1, VALUE, limits), { ok: true });
  const r = checkLevel(order(10_000.01), 1, VALUE, limits);
  assert.deepEqual([r.ok, r.ok === false && r.rule], [false, "LEVEL"]);
});

test("L2 needs a human for any order", () => {
  assert.equal(checkLevel(order(1_000), 2, VALUE, limits).ok, "needs-approval");
  assert.equal(checkLevel(order(1_000, "sell-volatile"), 2, VALUE, limits).ok, "needs-approval");
});

test("L3 rejects buys and needs approval for sells", () => {
  const buy = checkLevel(order(1_000), 3, VALUE, limits);
  assert.deepEqual([buy.ok, buy.ok === false && buy.rule], [false, "LEVEL"]);
  assert.equal(checkLevel(order(1_000, "sell-volatile"), 3, VALUE, limits).ok, "needs-approval");
});

test("L4 rejects everything, buy or sell", () => {
  for (const action of ["buy-volatile", "sell-volatile"] as const) {
    const r = checkLevel(order(1_000, action), 4, VALUE, limits);
    assert.deepEqual([r.ok, r.ok === false && r.rule], [false, "LEVEL"]);
  }
});

test("an unknown level or an unusable value rejects as invalid", () => {
  assert.equal(isLevel(5), false);
  assert.equal(isLevel("1"), false);
  const unknown = checkLevel(order(1_000), 7 as Level, VALUE, limits);
  assert.deepEqual([unknown.ok, unknown.ok === false && unknown.rule], [false, "INVALID_INPUT"]);
  const noValue = checkLevel(order(1_000), 1, 0, limits);
  assert.deepEqual([noValue.ok, noValue.ok === false && noValue.rule], [false, "INVALID_INPUT"]);
});
