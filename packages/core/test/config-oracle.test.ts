import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import { checkQuotes, ORACLE_DEFAULTS, oracleLimitProblems, type PriceQuote } from "../src/oracle.ts";

const quotes = (): PriceQuote[] => ["a", "b", "c"].map(source => ({ source, asset: "wNEAR", price: 100, observedAt: NOW }));

test("the default oracle limits are valid", () => assert.deepEqual(oracleLimitProblems(ORACLE_DEFAULTS), []));

test("an oracle limit that is NaN, infinite or out of range freezes the reading instead of switching a rule off", () => {
  const bad = [{ maxDisagreementPct: NaNv }, { maxDisagreementPct: -1 }, { maxDisagreementPct: 101 }, { maxStalenessMs: NaNv }, { maxStalenessMs: 0 },
    { maxStalenessMs: INF }, { minSources: NaNv }, { minSources: 0 }, { minSources: 2.5 }, { maxFutureSkewMs: -1 }, { maxFutureSkewMs: NaNv }];
  for (const change of bad) {
    const r = checkQuotes("wNEAR", quotes(), NOW, { ...ORACLE_DEFAULTS, ...change });
    assert.equal(r.frozen && r.reason, "invalid-config", JSON.stringify(change));
  }
  assert.equal(checkQuotes("wNEAR", quotes(), Number.NaN).frozen, true);
});

test("a NaN disagreement limit used to let wildly different sources through; now it freezes", () => {
  const apart = quotes().map((q, i) => ({ ...q, price: 100 * (i + 1) }));
  assert.equal(checkQuotes("wNEAR", apart, NOW, { ...ORACLE_DEFAULTS, maxDisagreementPct: NaNv }).frozen, true);
});
