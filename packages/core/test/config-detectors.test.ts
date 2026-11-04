import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
import { DETECTOR_DEFAULTS, detectMarketMoves, detectorProblems, type DetectorConfig } from "../src/detectors.ts";

test("the default detector thresholds are valid", () => assert.deepEqual(detectorProblems(DETECTOR_DEFAULTS), []));

test("an unusable detector configuration is a conservative detection, never silence", () => {
  const flat = Array.from({ length: 400 }, (_, i) => ({ at: NOW - (400 - i) * 300_000, price: 100 }));
  assert.deepEqual(detectMarketMoves(flat, NOW), []);
  for (const change of [{ crashPct: NaNv }, { hourMs: 0 }, { fastMovePct: { l1: 10, l2: 5 } }, { chop: { minReversals: 0, maxNetMovePct: 2 } }, { minHistoryMs: NaNv }]) {
    const found = detectMarketMoves(flat, NOW, { ...DETECTOR_DEFAULTS, ...change });
    assert.deepEqual(found.map(d => `${d.detector}:${d.level}`), ["config:1"], JSON.stringify(change));
  }
});

const flat = Array.from({ length: 400 }, (_, i) => ({ at: NOW - (400 - i) * 300_000, price: 100 }));
const reasonFor = (change: object) => {
  const found = detectMarketMoves(flat, NOW, { ...DETECTOR_DEFAULTS, ...change } as unknown as DetectorConfig);
  assert.deepEqual(found.map(d => `${d.detector}:${d.level}`), ["config:1"], JSON.stringify(change));
  return found[0]!.reason;
};

test("a crash or fast-move threshold of 100% or more is refused, since a price can't fall that far", () => {
  for (const change of [{ crashPct: 100 }, { crashPct: 150 }, { fastMovePct: { l1: 10, l2: 100 } }, { fastMovePct: { l1: 120, l2: 150 } }])
    assert.match(reasonFor(change), /under 100/);
  assert.deepEqual(detectorProblems({ ...DETECTOR_DEFAULTS, crashPct: 99.9, fastMovePct: { l1: 50, l2: 99.9 } }), []);
});

test("a parabolic threshold above 100% is allowed, since a price can more than double", () => {
  assert.deepEqual(detectorProblems({ ...DETECTOR_DEFAULTS, parabolicPct: 150 }), []);
});

test("a missing or unusable sample-age limit is refused", () => {
  for (const change of [{ maxSampleAgeMs: 0 }, { maxSampleAgeMs: NaNv }, { maxSampleAgeMs: INF }, { maxSampleAgeMs: undefined }])
    assert.match(reasonFor(change), /maxSampleAgeMs/);
});

test("a missing nested setting is a clear configuration problem, not a crash", () => {
  assert.match(reasonFor({ chop: undefined }), /chop must be given/);
  assert.match(reasonFor({ fastMovePct: undefined }), /fastMovePct must be given/);
  assert.match(reasonFor({ chop: null, fastMovePct: 5 }), /fastMovePct must be given.*chop must be given/);
  const none = detectMarketMoves(flat, NOW, null as unknown as DetectorConfig);
  assert.deepEqual(none.map(d => `${d.detector}:${d.level}`), ["config:1"]);
  assert.match(none[0]!.reason, /must be an object/);
});
