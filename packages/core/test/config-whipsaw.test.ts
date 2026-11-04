import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import { BAND_DEFAULTS } from "../src/bands.ts";
import type { Intent } from "../src/bands.ts";
import { ENGINE_DEFAULTS, evaluateBands } from "../src/engine.ts";
import { SIZING_DEFAULTS } from "../src/sizing.ts";
import { gate, nextState, WHIPSAW_DEFAULTS, whipsawProblems } from "../src/whipsaw.ts";

const buy: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 100, dcaUnits: 1, reason: "", at: 1 };
const reading = (twap15m: number) => ({ frozen: false as const, asset: "wNEAR", at: NOW, quotes: [], median: twap15m, ema30d: 100, twap15m });

test("the default anti-whipsaw limits are valid", () => assert.deepEqual(whipsawProblems(WHIPSAW_DEFAULTS), []));

test("unusable anti-whipsaw limits hold the trade and leave the state alone", () => {
  for (const change of [{ cooldownMs: NaNv }, { cooldownMs: -1 }, { reversalLockMs: NaNv }, { hysteresisPct: NaNv }, { hysteresisPct: 500 }]) {
    const limits = { ...WHIPSAW_DEFAULTS, ...change };
    assert.equal(gate(buy, {}, "normal", NOW, limits).action, "hold", JSON.stringify(change));
    const state = { disarmed: "dca-1" as const };
    assert.equal(nextState(state, { ...buy, action: "hold", zone: "hold" }, -10, NOW, limits), state);
  }
});

test("the engine holds when any part of its configuration is unusable", () => {
  const input = { portfolio: { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 }, bounds: { volatileMinPct: 10, volatileMaxPct: 70 },
    sizing: { dcaUnitsUsed: 0 }, whipsaw: {}, regime: "normal" as const };
  assert.equal(evaluateBands(reading(80), input).action, "buy-volatile");
  assert.equal(evaluateBands(reading(80), input, { ...ENGINE_DEFAULTS, bands: { ...BAND_DEFAULTS, buyHalt: NaNv } }).action, "hold");
  assert.equal(evaluateBands(reading(80), input, { ...ENGINE_DEFAULTS, sizing: { ...SIZING_DEFAULTS, dcaUnits: NaNv } }).action, "hold");
  assert.equal(evaluateBands(reading(80), input, { ...ENGINE_DEFAULTS, whipsaw: { ...WHIPSAW_DEFAULTS, cooldownMs: NaNv } }).action, "hold");
});
