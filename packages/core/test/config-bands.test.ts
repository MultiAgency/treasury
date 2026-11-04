import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import { BAND_DEFAULTS, bandProblems, classifyZone, intentForZone } from "../src/bands.ts";

const reading = (twap15m: number) => ({ frozen: false as const, asset: "wNEAR", at: NOW, quotes: [], median: twap15m, ema30d: 100, twap15m });

test("the default band thresholds are valid", () => assert.deepEqual(bandProblems(BAND_DEFAULTS), []));

test("unusable band thresholds make no zone and hold, instead of trading on a broken line", () => {
  const bad = [
    { ...BAND_DEFAULTS, trim: [NaNv, 25, 40] as const }, { ...BAND_DEFAULTS, trim: [25, 15, 40] as const }, { ...BAND_DEFAULTS, trim: [-1, 25, 40] as const },
    { ...BAND_DEFAULTS, dca: [15, -25, -35] as const }, { ...BAND_DEFAULTS, dca: [-15, -10, -35] as const },
    { ...BAND_DEFAULTS, buyHalt: NaNv }, { ...BAND_DEFAULTS, buyHalt: -20 }, { ...BAND_DEFAULTS, buyHalt: 5 },
  ];
  for (const bands of bad) {
    assert.equal(classifyZone(120, 100, bands), null, JSON.stringify(bands));
    const p = intentForZone(reading(120), bands);
    assert.deepEqual([p.action, p.sizeUsd], ["hold", 0]);
    assert.match(p.reason, /invalid band configuration/);
  }
});
