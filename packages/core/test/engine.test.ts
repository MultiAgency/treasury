import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBands, type EngineInput } from "../src/engine.ts";
import type { OracleReading } from "../src/oracle.ts";

const AT = 1_800_000_000_000;
const reading = (twap15m: number): OracleReading => ({ frozen: false, asset: "wNEAR", at: AT, quotes: [], median: twap15m, ema30d: 100, twap15m });
const input: EngineInput = {
  portfolio: { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 },
  bounds: { volatileMinPct: 10, volatileMaxPct: 70 },
  sizing: { dcaUnitsUsed: 0 },
  whipsaw: {},
  regime: "normal",
};

test("a DCA zone gives a sized buy", () => {
  const p = evaluateBands(reading(80), input);
  assert.deepEqual([p.zone, p.action], ["dca-1", "buy-volatile"]);
  assert.ok(p.sizeUsd > 0 && p.sizeUsd <= 20_000);
});

test("a trim zone gives a sized sell", () => {
  const p = evaluateBands(reading(130), input);
  assert.deepEqual([p.zone, p.action], ["trim-2", "sell-volatile"]);
  assert.ok(p.sizeUsd > 0);
});

test("inside the hold band, and in the buy halt, nothing trades", () => {
  assert.equal(evaluateBands(reading(100), input).action, "hold");
  assert.equal(evaluateBands(reading(50), input).action, "hold");
});

test("a frozen oracle holds", () => {
  const frozen: OracleReading = { frozen: true, asset: "wNEAR", at: AT, quotes: [], reason: "stale", detail: "" };
  assert.equal(evaluateBands(frozen, input).action, "hold");
});

test("a regime other than normal holds, with a size of zero", () => {
  const p = evaluateBands(reading(80), { ...input, regime: "fast-move" });
  assert.deepEqual([p.action, p.sizeUsd], ["hold", 0]);
});

test("a spent DCA budget holds", () => {
  assert.equal(evaluateBands(reading(80), { ...input, sizing: { dcaUnitsUsed: 10 } }).action, "hold");
});

test("a recent action holds the next one", () => {
  const recent = { lastActionAt: AT - 60_000, lastAction: "buy-volatile" as const };
  assert.equal(evaluateBands(reading(80), { ...input, whipsaw: recent }).action, "hold");
});

test("the same inputs always give the same intent", () => {
  assert.deepEqual(evaluateBands(reading(80), input), evaluateBands(reading(80), input));
});
