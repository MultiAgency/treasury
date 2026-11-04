import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import { DETECTOR_DEFAULTS, detectMarketMoves, detectorProblems } from "../src/detectors.ts";

test("the default detector thresholds are valid", () => assert.deepEqual(detectorProblems(DETECTOR_DEFAULTS), []));

test("an unusable detector configuration is a conservative detection, never silence", () => {
  const flat = Array.from({ length: 400 }, (_, i) => ({ at: NOW - (400 - i) * 300_000, price: 100 }));
  assert.deepEqual(detectMarketMoves(flat, NOW), []);
  for (const change of [{ crashPct: NaNv }, { hourMs: 0 }, { fastMovePct: { l1: 10, l2: 5 } }, { chop: { minReversals: 0, maxNetMovePct: 2 } }, { minHistoryMs: NaNv }]) {
    const found = detectMarketMoves(flat, NOW, { ...DETECTOR_DEFAULTS, ...change });
    assert.deepEqual(found.map(d => `${d.detector}:${d.level}`), ["config:1"], JSON.stringify(change));
  }
});
