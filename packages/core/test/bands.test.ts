import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_DEFAULTS, classifyZone, deviationPct, proposeZone, type BandZone } from "../src/bands.ts";
import type { OracleReading } from "../src/oracle.ts";

const AT = 1_800_000_000_000;
const reading = (twap15m: number, ema30d = 100): OracleReading =>
  ({ frozen: false, asset: "wNEAR", at: AT, quotes: [], median: twap15m, ema30d, twap15m });

test("every zone, exactly on its threshold, just inside, and just past", () => {
  const cases: [number, BandZone][] = [
    [100, "hold"], [114.99, "hold"], [85.01, "hold"],
    [115, "trim-1"], [124.99, "trim-1"], [125, "trim-2"], [139.99, "trim-2"], [140, "trim-3"], [500, "trim-3"],
    [85, "dca-1"], [75.01, "dca-1"], [75, "dca-2"], [65.01, "dca-2"], [65, "dca-3"], [55.01, "dca-3"],
    [55, "buy-halt"], [10, "buy-halt"],
  ];
  for (const [price, zone] of cases) assert.equal(classifyZone(price, 100), zone, `price ${price}`);
});

test("thresholds are exact for prices exact in binary, at any scale", () => {
  assert.equal(classifyZone(11_500, 10_000), "trim-1");
  assert.equal(classifyZone(1_150_000, 1_000_000), "trim-1");
  assert.equal(classifyZone(8_500, 10_000), "dca-1");
  assert.equal(classifyZone(5_500, 10_000), "buy-halt");
});

test("unusable prices have no zone", () => {
  for (const [t, e] of [[0, 100], [100, 0], [-1, 100], [100, -1], [Number.NaN, 100], [100, Number.POSITIVE_INFINITY]] as const)
    assert.equal(classifyZone(t, e), null);
});

test("the zone's direction: trims sell, DCA buys, hold and buy halt do nothing", () => {
  assert.equal(proposeZone(reading(120)).action, "sell-volatile");
  assert.equal(proposeZone(reading(80)).action, "buy-volatile");
  assert.equal(proposeZone(reading(100)).action, "hold");
  const halt = proposeZone(reading(50));
  assert.deepEqual([halt.zone, halt.action], ["buy-halt", "hold"]);
});

test("no proposal has a size yet", () => {
  for (const price of [100, 120, 80, 50]) assert.deepEqual([proposeZone(reading(price)).sizeUsd, proposeZone(reading(price)).dcaUnits], [0, 0]);
});

test("a frozen oracle always holds, with its reason", () => {
  const frozen: OracleReading = { frozen: true, asset: "wNEAR", at: AT, quotes: [], reason: "disagreement", detail: "" };
  const p = proposeZone(frozen);
  assert.deepEqual([p.action, p.sizeUsd], ["hold", 0]);
  assert.match(p.reason, /disagreement/);
});

test("an unusable EMA holds", () => {
  const p = proposeZone(reading(120, 0));
  assert.deepEqual([p.action, p.zone], ["hold", "hold"]);
});

test("deviation is the percent distance from the reference", () => {
  assert.equal(deviationPct(115, 100), 15);
  assert.equal(deviationPct(85, 100), -15);
  assert.equal(deviationPct(100, 0), null);
});

test("custom bands move the thresholds", () => {
  const bands = { ...BAND_DEFAULTS, trim: [5, 10, 20] as const };
  assert.equal(classifyZone(105, 100, bands), "trim-1");
});

test("same input, same proposal", () => {
  assert.deepEqual(proposeZone(reading(120)), proposeZone(reading(120)));
});
