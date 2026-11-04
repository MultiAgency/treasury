import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, nextState, stateProblems, WHIPSAW_DEFAULTS, type WhipsawState } from "../src/whipsaw.ts";
import { classifyZone, deviationPct, type BandZone, type Intent } from "../src/bands.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const buy = (zone: BandZone = "dca-1"): Intent => ({ id: "p", zone, action: "buy-volatile", sizeUsd: 100, dcaUnits: 1, reason: zone, at: NOW });
const sell = (zone: BandZone = "trim-1"): Intent => ({ ...buy(zone), action: "sell-volatile" });
const none: WhipsawState = {};

test("the first action in a normal regime passes", () => {
  assert.deepEqual(gate(buy(), none, "normal", NOW), buy());
});

test("any regime but normal holds", () => {
  for (const regime of ["fast-move", "thin-liquidity", "source-stress"] as const) {
    const p = gate(buy(), none, regime, NOW);
    assert.deepEqual([p.action, p.sizeUsd], ["hold", 0]);
    assert.match(p.reason, new RegExp(regime));
  }
});

test("a second action inside the cooldown holds; exactly at the cooldown it passes", () => {
  const state = { lastActionAt: NOW - HOUR + 1, lastAction: "buy-volatile" as const };
  assert.match(gate(buy("dca-2"), state, "normal", NOW).reason, /cooling down/);
  assert.equal(gate(buy("dca-2"), { ...state, lastActionAt: NOW - HOUR }, "normal", NOW).action, "buy-volatile");
});

test("the opposite direction is locked out for a day, then free", () => {
  const state = { lastActionAt: NOW - 2 * HOUR, lastAction: "sell-volatile" as const };
  assert.match(gate(buy(), state, "normal", NOW).reason, /reversal locked/);
  assert.equal(gate(buy(), { ...state, lastActionAt: NOW - 24 * HOUR }, "normal", NOW).action, "buy-volatile");
});

test("the same zone doesn't trade again until it re-arms", () => {
  const state = { lastActionAt: NOW - 48 * HOUR, lastAction: "buy-volatile" as const, disarmed: "dca-1" as const };
  assert.match(gate(buy("dca-1"), state, "normal", NOW).reason, /re-arm/);
  assert.equal(gate(buy("dca-2"), state, "normal", NOW).action, "buy-volatile");
});

test("a future-dated last action holds", () => {
  assert.equal(gate(buy(), { lastActionAt: NOW + 1, lastAction: "buy-volatile" }, "normal", NOW).action, "hold");
});

test("an action records its time, direction and zone", () => {
  assert.deepEqual(nextState(none, buy("dca-2"), -26, NOW), { lastActionAt: NOW, lastAction: "buy-volatile", disarmed: "dca-2" });
});

test("a disarmed buy zone re-arms 2 points back inside its line, not before", () => {
  const hold: Intent = { ...buy(), action: "hold", zone: "hold", sizeUsd: 0, dcaUnits: 0 };
  const state: WhipsawState = { lastActionAt: NOW, lastAction: "buy-volatile", disarmed: "dca-1" }; // line −15
  assert.equal(nextState(state, hold, -15.5, NOW + HOUR).disarmed, "dca-1");
  assert.equal(nextState(state, hold, -13.5, NOW + HOUR).disarmed, "dca-1");
  assert.equal(nextState(state, hold, -13, NOW + HOUR).disarmed, undefined);
});

test("a disarmed trim zone re-arms 2 points back below its line; the lines inside it re-arm only past their own", () => {
  const hold: Intent = { ...sell(), action: "hold", zone: "hold", sizeUsd: 0, dcaUnits: 0 };
  const state: WhipsawState = { lastActionAt: NOW, lastAction: "sell-volatile", disarmed: "trim-2" }; // lines +25, +15
  assert.equal(nextState(state, hold, 24, NOW).disarmed, "trim-2");
  assert.equal(nextState(state, hold, 23, NOW).disarmed, "trim-1");
  assert.equal(nextState(state, hold, 13.5, NOW).disarmed, "trim-1");
  assert.equal(nextState(state, hold, 13, NOW).disarmed, undefined);
});

test("a trade disarms every line it crossed on its side, but not deeper lines or the other side", () => {
  const state: WhipsawState = { lastActionAt: NOW - 48 * HOUR, lastAction: "sell-volatile", disarmed: "trim-2" };
  assert.match(gate(sell("trim-2"), state, "normal", NOW).reason, /re-arm/);
  assert.match(gate(sell("trim-1"), state, "normal", NOW).reason, /re-arm/);
  assert.equal(gate(sell("trim-3"), state, "normal", NOW).action, "sell-volatile");
  assert.equal(gate(buy("dca-1"), state, "normal", NOW).action, "buy-volatile");
});

test("with no usable deviation a disarmed zone stays disarmed", () => {
  const hold: Intent = { ...buy(), action: "hold", zone: "hold", sizeUsd: 0, dcaUnits: 0 };
  const state: WhipsawState = { disarmed: "dca-1" };
  assert.equal(nextState(state, hold, null, NOW), state);
});

test("price bouncing across one line trades once", () => {
  let state: WhipsawState = none;
  const trades: number[] = [];
  // Deviation crosses −15 and back several times inside the cooldown and the hysteresis band.
  for (const [i, dev] of [-16, -14, -16, -14.5, -16, -15.2].entries()) {
    const now = NOW + i * 5 * 60_000;
    const intended = gate({ ...buy("dca-1"), action: dev <= -15 ? "buy-volatile" : "hold" }, state, "normal", now);
    if (intended.action !== "hold") trades.push(i);
    state = nextState(state, intended, dev, now);
  }
  assert.deepEqual(trades, [0]);
});

/** Runs a TWAP series against an EMA of 100 through the zones, the gate and the state, and returns the zones traded. */
function run(twaps: number[], stepMs: number): string[] {
  let state: WhipsawState = none;
  const traded: string[] = [];
  for (const [i, twap] of twaps.entries()) {
    const now = NOW + i * stepMs;
    const zone = classifyZone(twap, 100)!;
    const action = zone.startsWith("trim") ? "sell-volatile" : zone.startsWith("dca") ? "buy-volatile" : "hold";
    const intended = gate({ ...buy(zone), action, at: now }, state, "normal", now);
    if (intended.action !== "hold") traded.push(intended.zone);
    state = nextState(state, intended, deviationPct(twap, 100), now);
  }
  return traded;
}

test("a TWAP alternating either side of +25% every 2 hours sells once, not on every cooldown", () => {
  const series = Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? 125.1 : 124.9)); // 16 hours
  assert.deepEqual(run(series, 2 * HOUR), ["trim-2"]);
  // Starting just under the line, +15% is crossed first and +25% after it: each line sells once, then nothing more.
  assert.deepEqual(run(series.slice(1), 2 * HOUR), ["trim-1", "trim-2"]);
});

test("a TWAP alternating either side of -25% or -35% every 2 hours buys once per line at most", () => {
  assert.deepEqual(run(Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? 74.9 : 75.1)), 2 * HOUR), ["dca-2"]);
  assert.deepEqual(run(Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? 64.9 : 65.1)), 2 * HOUR), ["dca-3"]);
});

test("after retreating past the hysteresis the same line can trade again", () => {
  assert.deepEqual(run([125.1, 122.9, 125.1], 2 * HOUR), ["trim-2", "trim-2"]);
});

test("a partial or inconsistent state holds instead of skipping the cooldown and reversal lock", () => {
  const bad: unknown[] = [
    { lastAction: "sell-volatile" },
    { lastActionAt: NOW - HOUR },
    { lastActionAt: Number.NaN, lastAction: "sell-volatile" },
    { lastActionAt: NOW - 48 * HOUR, lastAction: "hold" },
    { disarmed: "dca-1" },
    { lastActionAt: NOW - 48 * HOUR, lastAction: "sell-volatile", disarmed: "dca-1" },
    { lastActionAt: NOW - 48 * HOUR, lastAction: "buy-volatile", disarmed: "buy-halt" },
  ];
  for (const state of bad) {
    const p = gate(buy("dca-2"), state as WhipsawState, "normal", NOW);
    assert.deepEqual([p.action, p.sizeUsd], ["hold", 0], JSON.stringify(state));
    assert.match(p.reason, /unusable anti-whipsaw state/);
    assert.deepEqual(stateProblems(state as WhipsawState).length > 0, true);
  }
  assert.deepEqual(stateProblems(none), []);
  assert.deepEqual(stateProblems(nextState(none, sell("trim-2"), 26, NOW)), []);
});

test("defaults are the documented ones", () => {
  assert.deepEqual(WHIPSAW_DEFAULTS, { cooldownMs: 3_600_000, reversalLockMs: 86_400_000, hysteresisPct: 2 });
});
