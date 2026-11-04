import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSamples, ema, historySpan, largestGap, twap } from "../src/smoothing.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("samples that are unusable are dropped, and the rest are ordered, one per timestamp", () => {
  const cleaned = cleanSamples([
    { at: NOW - 2, price: 5 }, { at: NOW - 3, price: 4 }, { at: NOW - 4, price: 7 }, { at: NOW - 4, price: 7 },
    { at: NOW + 1, price: 5 }, { at: NOW - 1, price: 0 }, { at: NOW - 1, price: Number.NaN },
  ], NOW);
  assert.deepEqual(cleaned, [{ at: NOW - 4, price: 7 }, { at: NOW - 3, price: 4 }, { at: NOW - 2, price: 5 }]);
});

test("two prices at one instant are ambiguous: the instant is dropped, so the order they come in doesn't matter", () => {
  const at = NOW - 10 * MIN, before = { at: NOW - 20 * MIN, price: 100 };
  const one = [before, { at, price: 100 }, { at, price: 200 }], other = [before, { at, price: 200 }, { at, price: 100 }];
  assert.deepEqual(cleanSamples(one, NOW), [before]);
  assert.deepEqual(cleanSamples(other, NOW), [before]);
  near(twap(one, NOW, 15 * MIN), 100);
  assert.equal(twap(one, NOW, 15 * MIN), twap(other, NOW, 15 * MIN));
});

test("the largest gap over a window counts from the sample holding at its start up to now", () => {
  const samples = [{ at: NOW - 30 * MIN, price: 1 }, { at: NOW - 5 * MIN, price: 1 }, { at: NOW, price: 1 }];
  assert.equal(largestGap(samples, NOW, 15 * MIN), 25 * MIN, "the sample before the window holds until the next");
  assert.equal(largestGap([{ at: NOW - 30 * MIN, price: 1 }], NOW, 15 * MIN), 30 * MIN, "the last sample holds until now");
  assert.equal(largestGap([{ at: NOW - 5 * MIN, price: 1 }], NOW, 15 * MIN), null, "nothing holds at the window's start");
});

test("TWAP: 100 for 5 minutes then 110 for 10 minutes over a 15-minute window", () => {
  const samples = [{ at: NOW - 20 * MIN, price: 100 }, { at: NOW - 10 * MIN, price: 110 }];
  near(twap(samples, NOW, 15 * MIN), (100 * 5 + 110 * 10) / 15);
});

test("TWAP of a flat price is that price, and a sample exactly at the window start covers it", () => {
  near(twap([{ at: NOW - 15 * MIN, price: 42 }], NOW, 15 * MIN), 42);
});

test("TWAP is null when the history doesn't reach back to the start of the window", () => {
  assert.equal(twap([{ at: NOW - 14 * MIN, price: 100 }], NOW, 15 * MIN), null);
  assert.equal(twap([], NOW, 15 * MIN), null);
});

test("EMA: one step of a time constant moves 1 − 1/e of the way to the new price", () => {
  const tau = 1000;
  near(ema([{ at: NOW - tau, price: 100 }, { at: NOW, price: 200 }], NOW, tau), 100 + (1 - Math.exp(-1)) * 100);
});

test("EMA of a flat price is that price; of an empty history is null", () => {
  near(ema([{ at: NOW - 2000, price: 7 }, { at: NOW - 1000, price: 7 }, { at: NOW, price: 7 }], NOW, 500), 7);
  assert.equal(ema([], NOW, 500), null);
});

test("history span is measured from the oldest usable sample", () => {
  assert.equal(historySpan([{ at: NOW - 5000, price: 1 }, { at: NOW - 100, price: 1 }], NOW), 5000);
  assert.equal(historySpan([], NOW), 0);
});
