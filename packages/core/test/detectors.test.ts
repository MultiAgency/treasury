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

test("fast rise: exactly +10% in an hour is L1, +20% is L2, just under each is the level below", () => {
  const rise = (to: number) => series(ago => (ago < 60 ? to : 100));
  assert.deepEqual(names(rise(109.99)), []);
  assert.deepEqual(names(rise(110)), ["fast-rise:1"]);
  assert.deepEqual(names(rise(119.99)), ["fast-rise:1"]);
  assert.deepEqual(names(rise(120)), ["fast-rise:2"]);
});

test("fast drop: exactly −10% in an hour is L1, −20% is L2, just short of each is the level below", () => {
  const drop = (to: number) => series(ago => (ago < 60 ? to : 100));
  assert.deepEqual(names(drop(90.01)), []);
  assert.deepEqual(names(drop(90)), ["fast-drop:1"]);
  assert.deepEqual(names(drop(80.01)), ["fast-drop:1"]);
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

test("crash: a fall of 30% from the day's high is L3 even when the day's net move is small", () => {
  // 100, then up to a high 20h ago, then down 10h ago: the net move over the day is small, the fall from the high is not.
  const peak = (high: number, to: number) => series(ago => (ago >= 20 * 60 ? 100 : ago >= 10 * 60 ? high : to));
  assert.deepEqual(names(peak(130, 91.01)), []);
  assert.deepEqual(names(peak(130, 91)), ["crash:3"]);
  // The review's case: 100 → 140 → 98 is both a 40% rise from the low and a 30% fall from the high.
  assert.deepEqual(names(peak(140, 98)), ["crash:3", "parabolic:2"]);
});

test("parabolic: a rise of 40% from the day's low is L2 even when the day's net move is small", () => {
  const trough = (low: number, to: number) => series(ago => (ago >= 20 * 60 ? 100 : ago >= 10 * 60 ? low : to));
  assert.deepEqual(names(trough(75, 104.99)), []);
  assert.deepEqual(names(trough(75, 105)), ["parabolic:2"]);
});

test("a fall before the day's high isn't a crash, and a rise before its low isn't parabolic", () => {
  // Down 25% then up 40% from 100: a rise from the low, not a crash from the later high.
  assert.deepEqual(names(series(ago => (ago >= 20 * 60 ? 100 : ago >= 10 * 60 ? 75 : 105))), ["parabolic:2"]);
});

/**
 * One day of moves after 100: `levels[k]` holds for the k-th two-hour block, the last level to the end of the day. Each
 * change of direction between levels is a reversal.
 */
const day = (levels: number[]) => series(ago => (ago >= 24 * 60 ? 100 : levels[Math.min(Math.floor((24 * 60 - 1 - ago) / 120), levels.length - 1)]!));

test("sideways chop at its boundary: exactly 6 reversals and a 2% net move is L1", () => {
  assert.deepEqual(names(day([101, 99, 101, 99, 101, 99, 102])), ["sideways-chop:1"]);
});

test("sideways chop just under its boundary: 5 reversals, or a net move just over 2%, is nothing", () => {
  assert.deepEqual(names(day([99, 101, 99, 101, 99, 102])), []);
  assert.deepEqual(names(day([101, 99, 101, 99, 101, 99, 102.01])), []);
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

test("stale history is a conservative L1 and never silence, however far back it reaches", () => {
  // The review's case: five-minute samples from 3 days ago up to 12 hours ago, all at 100.
  const old = Array.from({ length: 60 * 12 + 1 }, (_, i) => ({ at: NOW - 72 * HOUR + i * 5 * MIN, price: 100 }));
  const found = detectMarketMoves(old, NOW);
  assert.deepEqual(found.map(d => `${d.detector}:${d.level}`), ["history:1"]);
  assert.match(found[0]!.reason, /720 min old/);
});

test("the newest sample may be exactly 15 minutes old; a moment older is stale", () => {
  const shifted = (byMs: number) => flat().map(s => ({ at: s.at - byMs, price: s.price }));
  assert.deepEqual(names(shifted(15 * MIN)), []);
  assert.deepEqual(names(shifted(15 * MIN + 1)), ["history:1"]);
  const cfg = { ...DETECTOR_DEFAULTS, maxSampleAgeMs: HOUR };
  assert.deepEqual(detectMarketMoves(shifted(30 * MIN), NOW, cfg), []);
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
