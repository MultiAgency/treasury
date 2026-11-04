import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMarketMoves, highestLevel, DETECTOR_DEFAULTS } from "../src/detectors.ts";
import type { Sample } from "../src/smoothing.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000, HOUR = 3_600_000;
/** Samples every 5 minutes for 26 hours, price given by `at(minutesAgo)`. */
const series = (priceAt: (minutesAgo: number) => number): Sample[] =>
  Array.from({ length: 26 * 12 + 1 }, (_, i) => { const ago = (26 * 12 - i) * 5; return { at: NOW - ago * MIN, price: priceAt(ago) }; });
const flat = (p = 100) => series(() => p);
const names = (s: Sample[]) => detectMarketMoves(s, NOW).map(d => `${d.detector}:${d.level}`);

test("a flat market raises nothing", () => {
  assert.deepEqual(names(flat()), []);
  assert.equal(highestLevel(detectMarketMoves(flat(), NOW)), 0);
});

test("fast rise: exactly +10% in an hour is L1, +20% is L2, just under is nothing", () => {
  const rise = (to: number) => series(ago => (ago < 60 ? to : 100));
  assert.deepEqual(names(rise(109.99)), []);
  assert.deepEqual(names(rise(110)), ["fast-rise:1"]);
  assert.deepEqual(names(rise(120)), ["fast-rise:2"]);
});

test("fast drop: exactly −10% in an hour is L1, −20% is L2, just over is nothing", () => {
  const drop = (to: number) => series(ago => (ago < 60 ? to : 100));
  assert.deepEqual(names(drop(90.01)), []);
  assert.deepEqual(names(drop(90)), ["fast-drop:1"]);
  assert.deepEqual(names(drop(80)), ["fast-drop:2"]);
});

test("crash: a fall of exactly 30% over a day is L3, even if the last hour was calm", () => {
  const slow = (to: number) => series(ago => (ago < 90 ? to : 100));
  assert.deepEqual(names(slow(70.01)), []);
  assert.deepEqual(names(slow(70)), ["crash:3"]);
  assert.equal(highestLevel(detectMarketMoves(slow(70), NOW)), 3);
});

test("parabolic: a rise of exactly 40% over a day is L2", () => {
  const slow = (to: number) => series(ago => (ago < 90 ? to : 100));
  assert.deepEqual(names(slow(139.99)), []);
  assert.deepEqual(names(slow(140)), ["parabolic:2"]);
});

test("sideways chop: many reversals with no net move is L1; a steady drift is not", () => {
  assert.deepEqual(names(series(ago => ((ago / 5) % 2 === 0 ? 100 : 101))), ["sideways-chop:1"]);
  assert.deepEqual(names(series(ago => 100 + (26 * 60 - ago) / (26 * 60))), []);
});

test("chop needs the net move to be small: reversals alone around a real trend aren't chop", () => {
  const trend = series(ago => 100 + (26 * 60 - ago) / 20 + ((ago / 5) % 2 === 0 ? 0 : 0.5));
  assert.equal(names(trend).includes("sideways-chop:1"), false);
});

test("too little history, or none, is a conservative L1 and never silence", () => {
  assert.deepEqual(names(flat().slice(-60)), ["history:1"]);
  assert.deepEqual(names([]), ["history:1"]);
  assert.deepEqual(names([{ at: NOW, price: 100 }]), ["history:1"]);
});

test("unusable samples are ignored, and the result is deterministic", () => {
  const dirty = [...flat(), { at: NOW - 1, price: Number.NaN }, { at: NOW + 5, price: 1 }];
  assert.deepEqual(names(dirty), []);
  assert.deepEqual(detectMarketMoves(flat(), NOW), detectMarketMoves(flat(), NOW));
});

test("the thresholds can be changed", () => {
  const cfg = { ...DETECTOR_DEFAULTS, fastMovePct: { l1: 2, l2: 4 } };
  const s = series(ago => (ago < 60 ? 103 : 100));
  assert.deepEqual(detectMarketMoves(s, NOW, cfg).map(d => `${d.detector}:${d.level}`), ["fast-rise:1"]);
});
