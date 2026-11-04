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
  // The two quotes differ, so the median shows which one was kept: the newest (100), not the older (50).
  const kept = checkQuotes("wNEAR", [q("a", 50, 1000), q("a", 100), q("b", 100), q("c", 100)], NOW);
  assert.equal(!kept.frozen && kept.median, 100);
  const older = checkQuotes("wNEAR", [q("a", 100), q("a", 50, 1000), q("b", 100), q("c", 100)], NOW);
  assert.equal(!older.frozen && older.median, 100, "order in the list doesn't matter");
});

test("source names are compared ignoring case and spaces", () => {
  const r = checkQuotes("wNEAR", [q("Binance", 100), q("binance ", 100), q("b", 100)], NOW);
  assert.equal(r.frozen && r.reason, "insufficient-sources");
});

test("a little clock skew is tolerated; more than the limit isn't", () => {
  const skew = ORACLE_DEFAULTS.maxFutureSkewMs;
  const ahead = (ms: number): PriceQuote => ({ source: "c", asset: "wNEAR", price: 100, observedAt: NOW + ms });
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 100), ahead(skew)], NOW).frozen, false);
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 100), ahead(skew + 1)], NOW).frozen, true);
});

test("limits that ask for zero sources are refused, and the reading freezes", () => {
  const limits = { ...ORACLE_DEFAULTS, minSources: 0 };
  const r = checkQuotes("wNEAR", [], NOW, limits);
  assert.equal(r.frozen && r.reason, "invalid-config");
  assert.equal(checkQuotes("wNEAR", three(), NOW, limits).frozen, true, "even with good quotes");
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
  const bad = [q("a", 100), q("b", 100), q("c", 100, 0, "ETH"), q("d", 0), q("e", Number.NaN), q("f", -5), { ...q("g", 100), observedAt: NOW + ORACLE_DEFAULTS.maxFutureSkewMs + 1 }];
  const r = checkQuotes("wNEAR", bad, NOW);
  assert.equal(r.frozen && r.reason, "insufficient-sources");
});

test("the limits can be changed", () => {
  const limits = { minSources: 2, maxDisagreementPct: 10, maxStalenessMs: 1000, maxFutureSkewMs: 0 };
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 109)], NOW, limits).frozen, false);
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("b", 112)], NOW, limits).frozen, true);
});

test("the same input always gives the same answer", () => {
  const input = three(100, 100.5, 99.7);
  assert.deepEqual(checkQuotes("wNEAR", input, NOW), checkQuotes("wNEAR", input, NOW));
});

// --- readOracle (A3.2) ---
import { readOracle, SMOOTHING_DEFAULTS } from "../src/oracle.ts";
import type { Sample } from "../src/smoothing.ts";

const DAY = 86_400_000;
const hourly = (days: number, price = 100): Sample[] =>
  Array.from({ length: days * 24 + 1 }, (_, i) => ({ at: NOW - (days * 24 - i + 1) * 3_600_000, price }));

test("a full history of 100 gives EMA 100, TWAP 100 and median 100", () => {
  const r = readOracle("wNEAR", three(), hourly(31), NOW);
  assert.ok(!r.frozen);
  assert.deepEqual(!r.frozen && [r.median, r.ema30d, r.twap15m].map(v => Math.round(v * 1e9) / 1e9), [100, 100, 100]);
});

test("a short history freezes as warming-up, not with a guess", () => {
  const r = readOracle("wNEAR", three(), hourly(10), NOW);
  assert.equal(r.frozen && r.reason, "warming-up");
  assert.equal(readOracle("wNEAR", three(), [], NOW).frozen, true);
});

test("a frozen quote check gives a frozen reading with the same reason, and no prices", () => {
  const r = readOracle("wNEAR", three(100, 100, 130), hourly(31), NOW);
  assert.ok(r.frozen);
  assert.equal(r.reason, "disagreement");
  assert.equal("median" in r, false);
});

test("the smoothing limits can be changed", () => {
  const short = { ...SMOOTHING_DEFAULTS, minEmaHistoryMs: DAY };
  assert.equal(readOracle("wNEAR", three(), hourly(2), NOW, undefined, short).frozen, false);
});

test("a reading is deterministic", () => {
  const h = hourly(31, 100);
  assert.deepEqual(readOracle("wNEAR", three(), h, NOW), readOracle("wNEAR", three(), h, NOW));
});

test("exactly the limit passes at prices near 1, where floating point is inexact", () => {
  const r = checkQuotes("wNEAR", three(0.98, 1, 1), NOW);
  assert.equal(r.frozen, false);
  assert.equal(checkQuotes("wNEAR", three(0.979, 1, 1), NOW).frozen, true);
});

test("a source with two different prices at the same instant is dropped, whatever the input order", () => {
  const q = (source: string, price: number): PriceQuote => ({ source, asset: "wNEAR", price, observedAt: NOW });
  const a = checkQuotes("wNEAR", [q("a", 100), q("a", 200), q("b", 101), q("c", 99)], NOW);
  const b = checkQuotes("wNEAR", [q("a", 200), q("a", 100), q("b", 101), q("c", 99)], NOW);
  assert.deepEqual(a, b);
  assert.equal(a.frozen && a.reason, "insufficient-sources");
  // the same price twice is not ambiguous
  assert.equal(checkQuotes("wNEAR", [q("a", 100), q("a", 100), q("b", 101), q("c", 99)], NOW).frozen, false);
});
