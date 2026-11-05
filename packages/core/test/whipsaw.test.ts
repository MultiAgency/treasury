import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, nextState, stateProblems, WHIPSAW_DEFAULTS, type WhipsawState } from "../src/whipsaw.ts";
import { classifyZone, type BandZone, type Intent } from "../src/bands.ts";

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
  const state: WhipsawState = { lastActionAt: NOW, lastAction: "buy-volatile", disarmed: "dca-1" }; // line −20
  assert.equal(nextState(state, hold, -20.5, NOW + HOUR).disarmed, "dca-1");
  assert.equal(nextState(state, hold, -18.5, NOW + HOUR).disarmed, "dca-1");
  assert.equal(nextState(state, hold, -18, NOW + HOUR).disarmed, undefined);
});

test("a partial, unreadable or inconsistent state holds instead of skipping the cooldown and reversal lock", () => {
  const bad: unknown[] = [
    { lastAction: "sell-volatile" },
    { lastActionAt: NOW - 48 * HOUR },
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
    assert.ok(stateProblems(state as WhipsawState).length > 0, JSON.stringify(state));
  }
  assert.deepEqual(stateProblems(none), []);
  assert.deepEqual(stateProblems(nextState(none, sell("trim-2"), 26, NOW)), []);
});

test("after a trade, the less extreme zones on its side are disarmed too; a more extreme one isn't", () => {
  const state: WhipsawState = { lastActionAt: NOW - 48 * HOUR, lastAction: "sell-volatile", disarmed: "trim-2" };
  assert.match(gate(sell("trim-1"), state, "normal", NOW).reason, /re-arm/);
  assert.match(gate(sell("trim-2"), state, "normal", NOW).reason, /re-arm/);
  assert.equal(gate(sell("trim-3"), state, "normal", NOW).action, "sell-volatile");
  assert.equal(gate(buy("dca-1"), state, "normal", NOW).action, "buy-volatile", "the other side is unaffected");
});

test("a price alternating across a line between two zones trades once, not on every crossing", () => {
  // The review on #30: a TWAP either side of the trim-2 line (then 125, now 130) every 2 hours gave 8 sells in 16 hours.
  let state: WhipsawState = none;
  const trades: string[] = [];
  for (let i = 0; i < 8; i++) {
    const now = NOW + i * 2 * HOUR, twap = i % 2 === 0 ? 130.1 : 129.9, zone = classifyZone(twap, 100)!;
    const proposed = gate(sell(zone), state, "normal", now);
    if (proposed.action !== "hold") trades.push(zone);
    state = nextState(state, proposed, (twap - 100) / 100 * 100, now);
  }
  assert.deepEqual(trades, ["trim-2"]);
});

test("a disarmed trim zone re-arms 2 points back below its line", () => {
  const hold: Intent = { ...sell(), action: "hold", zone: "hold", sizeUsd: 0, dcaUnits: 0 };
  const state: WhipsawState = { lastActionAt: NOW, lastAction: "sell-volatile", disarmed: "trim-2" }; // line +30
  assert.equal(nextState(state, hold, 29, NOW).disarmed, "trim-2");
  assert.equal(nextState(state, hold, 28, NOW).disarmed, "trim-1", "back below trim-2's line: trim-1 is still disarmed");
  assert.equal(nextState(state, hold, 18, NOW).disarmed, undefined, "back below trim-1's line too");
  assert.equal(nextState(nextState(state, hold, 28, NOW), hold, 18, NOW).disarmed, undefined, "one line at a time");
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

test("defaults are the documented ones", () => {
  assert.deepEqual(WHIPSAW_DEFAULTS, { cooldownMs: 3_600_000, reversalLockMs: 86_400_000, hysteresisPct: 2 });
});
