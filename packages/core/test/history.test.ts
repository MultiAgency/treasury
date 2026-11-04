import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistory, syntheticSeries, warmupHistory, HISTORY_DEFAULTS, type SyntheticSpec } from "../src/history.ts";
import { calibrationReport, maxDrawdownPct } from "../src/calibration.ts";
import { replay, REPLAY_DEFAULTS } from "../src/replay.ts";

const H = 3_600_000, DAY = 24 * H, T0 = 1_800_000_000_000;
const spec: SyntheticSpec = { startAt: T0, startPrice: 100, count: 400 * 24, stepMs: H, stepVolPct: 1, driftPct: 0, seed: 3 };
const csv = (rows: [number | string, number | string][]) => "timestamp,price\n" + rows.map(r => r.join(",")).join("\n");
const yearOf = (days = 366, gap = H) => Array.from({ length: Math.floor((days * DAY) / gap) + 1 }, (_, i): [number, number] => [T0 + i * gap, 100 + (i % 7)]);

test("a clean 12-month file loads, in any order, with a header and comments", () => {
  const rows = yearOf().reverse();
  const r = parseHistory("# source: test\n" + csv(rows) + "\n\n");
  assert.ok(r.ok);
  assert.equal(r.ok && r.samples[0]!.at, T0);
  assert.equal(r.ok && r.maxGapMs, H);
});

test("ISO timestamps are read", () => {
  const rows = yearOf(366, 6 * H).map(([t, p]) => [new Date(t).toISOString(), p] as [string, number]);
  assert.equal(parseHistory(csv(rows)).ok, true);
});

test("one bad row fails the whole load and names the line", () => {
  for (const bad of ["x,5", `${T0 + 1},0`, `${T0 + 1},-3`, `${T0 + 1},NaN`, `${T0 + 1},5,extra`, `${T0 + 1},`]) {
    const r = parseHistory(csv(yearOf()) + "\n" + bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.ok ? "" : r.problems.join(" "), /line \d+/);
  }
});

test("two prices at one instant fail; the same price twice is fine", () => {
  assert.equal(parseHistory(csv(yearOf()) + `\n${T0},999`).ok, false);
  assert.equal(parseHistory(csv(yearOf()) + `\n${T0},100`).ok, true);
});

test("a short span or a gap over the limit fails closed", () => {
  const short = parseHistory(csv(yearOf(300)));
  assert.equal(short.ok, false);
  const gapped = yearOf().filter((_, i) => i < 1000 || i > 1000 + 7);
  const g = parseHistory(csv(gapped));
  assert.equal(g.ok, false);
  assert.match(g.ok ? "" : g.problems.join(" "), /gap/);
  assert.equal(parseHistory(csv(yearOf(300)), { ...HISTORY_DEFAULTS, minSpanMs: 200 * DAY }).ok, true);
  assert.equal(parseHistory(csv(yearOf()), { minSpanMs: 0, maxGapMs: H }).ok, false);
  assert.equal(parseHistory("", HISTORY_DEFAULTS).ok, false);
});

test("the synthetic series is positive, deterministic and seed-dependent", () => {
  const a = syntheticSeries(spec), b = syntheticSeries(spec), c = syntheticSeries({ ...spec, seed: 4 });
  assert.equal(a.length, 9600);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every(s => s.price > 0 && Number.isFinite(s.price)));
  assert.deepEqual(syntheticSeries({ ...spec, stepVolPct: Number.NaN }), []);
  assert.deepEqual(syntheticSeries({ ...spec, count: 0 }), []);
});

test("warm-up history ends just before the first sample, is ordered and positive", () => {
  const first = { at: T0, price: 100 };
  const w = warmupHistory(first, 35 * DAY, H, 1, 9);
  assert.equal(w[w.length - 1]!.at, T0 - H);
  assert.equal(w[0]!.at, T0 - 35 * DAY);
  assert.ok(w.every((s, i) => s.price > 0 && (i === 0 || s.at > w[i - 1]!.at)));
  assert.deepEqual(w, warmupHistory(first, 35 * DAY, H, 1, 9));
  assert.deepEqual(warmupHistory(first, -1, H, 1, 9), []);
});

const config = { ...REPLAY_DEFAULTS, policy: { ...REPLAY_DEFAULTS.policy, exposure: { ...REPLAY_DEFAULTS.policy.exposure, monthlySpendUsd: 10_000 } } };
const start = { volatileUsd: 200_000, reserveUsd: 700_000, cashUsd: 100_000 };
const small: SyntheticSpec = { ...spec, count: 60 * 24 };

test("a seeded warm-up means the EMA is not frozen from the first step", () => {
  const series = syntheticSeries(small);
  const seed = warmupHistory(series[0]!, 35 * DAY, H, 1, 5);
  const cold = replay(series, start, config);
  const warm = replay(series, start, config, () => "normal", seed);
  assert.equal(cold.steps[0]!.outcome, "frozen");
  assert.notEqual(warm.steps[0]!.outcome, "frozen");
  assert.ok(warm.steps.filter(s => s.outcome === "frozen").length < cold.steps.filter(s => s.outcome === "frozen").length);
});

test("the report is reproducible, counts every step and lists the thresholds used", () => {
  const series = syntheticSeries(small), seed = warmupHistory(series[0]!, 35 * DAY, H, 1, 5);
  const make = () => calibrationReport(replay(series, start, config, () => "normal", seed), series, config, seed);
  const a = make(), b = make();
  assert.deepEqual(a, b);
  assert.equal(Object.values(a.outcomes).reduce((x, y) => x + y, 0), series.length);
  assert.equal(Object.values(a.timePerZone).reduce((x, y) => x + y, 0), series.length);
  assert.deepEqual(a.thresholds, config);
  assert.equal(a.thresholds.policy.exposure.monthlySpendUsd, 10_000);
  assert.ok(a.thresholds.engine.bands && a.thresholds.oracle.minSources === 3 && a.thresholds.smoothing.emaTauMs > 0);
  assert.equal(a.trades.count, a.outcomes.traded);
  assert.match(a.summary, /Rejections by rule/);
  const other = calibrationReport(replay(series, start, { ...config, seed: 2 }, () => "normal", seed), series, { ...config, seed: 2 }, seed);
  assert.notEqual(other.inputDigest, a.inputDigest);
});

test("the report counts warm-up freezes and rejections by rule", () => {
  const series = syntheticSeries(small);
  const cold = calibrationReport(replay(series, start, config), series, config);
  assert.ok(cold.frozen.warmingUp > 0 && cold.frozen.total === cold.frozen.warmingUp);
  const noRate = calibrationReport(replay(series, start, { ...config, policy: REPLAY_DEFAULTS.policy }, () => "normal", warmupHistory(series[0]!, 35 * DAY, H, 1, 5)), series, REPLAY_DEFAULTS, []);
  assert.ok(Object.values(noRate.rejectionsByRule).every(n => n > 0));
});

test("max drawdown: peak to trough, zero when it never falls, unusable points ignored", () => {
  assert.equal(maxDrawdownPct([{ valueUsd: 100 }, { valueUsd: 120 }, { valueUsd: 90 }, { valueUsd: 110 }]), 25);
  assert.equal(maxDrawdownPct([{ valueUsd: 1 }, { valueUsd: 2 }]), 0);
  assert.equal(maxDrawdownPct([]), 0);
  assert.equal(maxDrawdownPct([{ valueUsd: 100 }, { valueUsd: Number.NaN }, { valueUsd: 50 }]), 50);
});
