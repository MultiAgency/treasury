import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import { ORACLE_DEFAULTS, readOracle, SMOOTHING_DEFAULTS, smoothingProblems, type PriceQuote } from "../src/oracle.ts";
import { ema, twap } from "../src/smoothing.ts";

const quotes = (): PriceQuote[] => ["a", "b", "c"].map(source => ({ source, asset: "wNEAR", price: 100, observedAt: NOW }));

test("the default smoothing limits are valid", () => assert.deepEqual(smoothingProblems(SMOOTHING_DEFAULTS), []));

test("unusable smoothing limits freeze the reading; unusable windows give no average", () => {
  for (const change of [{ emaTauMs: 0 }, { emaTauMs: NaNv }, { twapWindowMs: -5 }, { twapWindowMs: NaNv }, { minEmaHistoryMs: -1 }, { maxSampleGapMs: 0 }, { maxSampleGapMs: NaNv }]) {
    const r = readOracle("wNEAR", quotes(), [], NOW, ORACLE_DEFAULTS, { ...SMOOTHING_DEFAULTS, ...change });
    assert.equal(r.frozen && r.reason, "invalid-config", JSON.stringify(change));
  }
  const history = [{ at: NOW - 1000, price: 100 }, { at: NOW, price: 100 }];
  assert.equal(twap(history, NOW, 0), null);
  assert.equal(twap(history, NOW, NaNv), null);
  assert.equal(ema(history, NOW, 0), null);
  assert.equal(ema(history, NOW, -1), null);
});
