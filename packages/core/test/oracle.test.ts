import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuotes, median, ORACLE_DEFAULTS, type PriceQuote } from "../src/oracle.ts";

const NOW = 1_800_000_000_000;
const q = (source: string, price: number, ageMs = 0, asset = "wNEAR"): PriceQuote => ({ source, asset, price, observedAt: NOW - ageMs });
const three = (a = 100, b = 100, c = 100) => [q("a", a), q("b", b), q("c", c)];

test("the median of an odd and an even list", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]));
});

test("three fresh agreeing sources give their median", () => {
  const r = checkQuotes("wNEAR", three(100, 101, 99), NOW);
  assert.deepEqual([r.frozen, r.frozen ? null : r.median], [false, 100]);
});

test("fewer than three sources freezes as insufficient", () => {
  const r = checkQuotes("wNEAR", three().slice(0, 2), NOW);
  assert.equal(r.frozen && r.reason, "insufficient-sources");
  assert.equal(checkQuotes("wNEAR", [], NOW).frozen, true);
});

test("one source quoting twice counts once, with its newest quote", () => {
  const r = checkQuotes("wNEAR", [q("a", 100, 1000), q("a", 100), q("b", 100)], NOW);
  assert.equal(r.frozen && r.reason, "insufficient-sources");
});

test("a quote exactly five minutes old is fresh; one millisecond older is stale", () => {
  const edge = ORACLE_DEFAULTS.maxStalenessMs;
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 100), q("c", 100, edge)], NOW).frozen, false);
  const r = checkQuotes("wNEAR", [q("a", 100), q("b", 100), q("c", 100, edge + 1)], NOW);
  assert.equal(r.frozen && r.reason, "stale");
});

test("sources exactly 2% apart pass; just over freezes as disagreement", () => {
  assert.equal(checkQuotes("wNEAR", three(98, 100, 100), NOW).frozen, false);
  const r = checkQuotes("wNEAR", three(97.9, 100, 100), NOW);
  assert.equal(r.frozen && r.reason, "disagreement");
});

test("a quote for another asset, a bad price or a future time doesn't count", () => {
  const bad = [q("a", 100), q("b", 100), q("c", 100, 0, "ETH"), q("d", 0), q("e", Number.NaN), q("f", -5), { ...q("g", 100), observedAt: NOW + 1 }];
  const r = checkQuotes("wNEAR", bad, NOW);
  assert.equal(r.frozen && r.reason, "insufficient-sources");
});

test("the limits can be changed", () => {
  const limits = { minSources: 2, maxDisagreementPct: 10, maxStalenessMs: 1000 };
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 109)], NOW, limits).frozen, false);
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 112)], NOW, limits).frozen, true);
});

test("the same input always gives the same answer", () => {
  const input = three(100, 100.5, 99.7);
  assert.deepEqual(checkQuotes("wNEAR", input, NOW), checkQuotes("wNEAR", input, NOW));
});
