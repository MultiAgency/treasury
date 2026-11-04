// Configurations that would switch a rule off, or are missing a nested field, fail closed: a problem, a hold, a
// conservative detection or INVALID_INPUT, never a rule that can't trigger and never a thrown TypeError.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_DEFAULTS, bandProblems, intentForZone, type Intent } from "../src/bands.ts";
import { DETECTOR_DEFAULTS, detectMarketMoves, detectorProblems } from "../src/detectors.ts";
import { EXPOSURE_CONFIG_DEFAULTS, exposureProblems } from "../src/exposure.ts";
import { checkLevel, LEVEL_DEFAULTS } from "../src/levels.ts";
import { SIZING_DEFAULTS, sizeIntent, sizingProblems } from "../src/sizing.ts";

const NOW = 1_800_000_000_000;
const buy: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 1_000, dcaUnits: 1, reason: "", at: 1 };
const flat = Array.from({ length: 400 }, (_, i) => ({ at: NOW - (400 - i) * 300_000, price: 100 }));

test("a crash or fast-move threshold of 100% or more is refused: a fall can't be that large", () => {
  for (const change of [{ crashPct: 100 }, { crashPct: 150 }, { fastMovePct: { l1: 10, l2: 100 } }, { fastMovePct: { l1: 120, l2: 150 } }]) {
    const cfg = { ...DETECTOR_DEFAULTS, ...change };
    assert.notDeepEqual(detectorProblems(cfg), [], JSON.stringify(change));
    assert.equal(detectMarketMoves(flat, NOW, cfg)[0]?.detector, "config", JSON.stringify(change));
  }
});

test("a monthly spend of 0 is refused: it would set the cash floor to 0, as operatingCashMonths: 0 would", () => {
  assert.notDeepEqual(exposureProblems({ ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 0 }), []);
  assert.deepEqual(exposureProblems({ ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: null }), [], "unset is refused by the check itself, not here");
});

test("a non-finite or non-positive order size is invalid input at every level", () => {
  const limits = { l1OrderCapFactor: LEVEL_DEFAULTS.l1OrderCapFactor, maxOrderPctOfTreasury: 2 };
  for (const sizeUsd of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) for (const level of [0, 1, 2, 3] as const) {
    const r = checkLevel({ ...buy, sizeUsd }, level, 1_000_000, limits);
    assert.equal(r.ok === false && r.rule, "INVALID_INPUT", `L${level} ${sizeUsd}`);
  }
});

test("a missing nested field is a problem, not a TypeError: bands, sizing and detectors", () => {
  const reading = { frozen: false as const, asset: "wNEAR", at: NOW, quotes: [], median: 130, ema30d: 100, twap15m: 130 };
  for (const bands of [{ ...BAND_DEFAULTS, trim: undefined }, { ...BAND_DEFAULTS, dca: undefined }] as never[]) {
    assert.notDeepEqual(bandProblems(bands), []);
    assert.equal(intentForZone(reading, bands).action, "hold");
  }
  for (const change of [{ dcaUnitsPerZone: undefined }, { trimPctOfVolatile: undefined }]) {
    const params = { ...SIZING_DEFAULTS, ...change } as never;
    assert.notDeepEqual(sizingProblems(params), [], JSON.stringify(change));
    assert.equal(sizeIntent(buy, { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 }, { volatileMinPct: 0, volatileMaxPct: 100 }, { dcaUnitsUsed: 0 }, params).action, "hold");
  }
  for (const change of [{ fastMovePct: undefined }, { chop: undefined }]) {
    const cfg = { ...DETECTOR_DEFAULTS, ...change } as never;
    assert.notDeepEqual(detectorProblems(cfg), [], JSON.stringify(change));
    assert.equal(detectMarketMoves(flat, NOW, cfg)[0]?.detector, "config");
  }
});
