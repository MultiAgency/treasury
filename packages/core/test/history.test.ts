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

test("a timestamp needs a zone: Z or an offset, or Unix ms; anything machine-local is unusable", () => {
  const rows = yearOf(366, 6 * H);
  const at = (stamp: string) => {
    const r = parseHistory(csv([[stamp, 100], ...rows.slice(1)]));
    return r.ok ? r.samples[0]!.at : r.problems.join(" ");
  };
  assert.equal(at(new Date(T0).toISOString()), T0);
  assert.equal(at(new Date(T0).toISOString().replace(".000Z", "Z")), T0);
  assert.equal(at(new Date(T0 + 9 * H).toISOString().replace(".000Z", "+09:00")), T0);
  assert.equal(at(new Date(T0 - 5 * H - 30 * 60_000).toISOString().replace(".000Z", "-05:30")), T0);
  assert.equal(at(String(T0)), T0);
  const local = new Date(T0).toISOString().replace(".000Z", "");
  for (const bad of [local, local.slice(0, 16), local.slice(0, 10), "1/2/2025", "Jan 2 2025 00:00:00 GMT", local.replace("T", " ") + "Z",
    local + "z", local + "+0900", local + "+24:00", "2025-02-30T00:00:00Z", "2025-01-02T24:00:00Z", `${T0}.5`, `-${T0}`, `${T0}e0`]) {
    assert.match(String(at(bad)), /line 2: unusable row/, bad);
  }
});

test("only a timestamp,price header is skipped; a bad first row fails the load", () => {
  for (const header of ["timestamp,price", "  Timestamp , PRICE  ", "\uFEFFtimestamp,price"]) {
    assert.equal(parseHistory(header + "\n" + csv(yearOf()).split("\n").slice(1).join("\n")).ok, true, header);
  }
  const body = csv(yearOf()).split("\n").slice(1).join("\n");
  for (const first of ["time,price", "x,5", "1/2/2025,100", "garbage"]) {
    const r = parseHistory("# comment\n" + first + "\n" + body);
    assert.equal(r.ok, false, first);
    assert.match(r.ok ? "" : r.problems.join(" "), /line 2: unusable row/, first);
  }
  assert.equal(parseHistory(body).ok, true);
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
/** A run or report that wasn't refused. */
const ok = <T extends { ok: boolean }>(result: T) => {
  assert.ok(result.ok, JSON.stringify((result as { problems?: unknown }).problems));
  return result as Extract<T, { ok: true }>;
};
const reported = (inputs: Parameters<typeof calibrationReport>[0]) => ok(calibrationReport(inputs));

test("a seeded warm-up means the EMA is not frozen from the first step", () => {
  const series = syntheticSeries(small);
  const seed = warmupHistory(series[0]!, 35 * DAY, H, 1, 5);
  const cold = ok(replay(series, start, config));
  const warm = ok(replay(series, start, config, () => "normal", seed));
  assert.equal(cold.steps[0]!.outcome, "frozen");
  assert.notEqual(warm.steps[0]!.outcome, "frozen");
  assert.ok(warm.steps.filter(s => s.outcome === "frozen").length < cold.steps.filter(s => s.outcome === "frozen").length);
});

test("the report is reproducible, counts every step and lists the thresholds used", () => {
  const series = syntheticSeries(small), seed = warmupHistory(series[0]!, 35 * DAY, H, 1, 5);
  const inputs = { series, seedHistory: seed, start, config };
  const a = reported(inputs), b = reported(structuredClone(inputs));
  assert.deepEqual(a, b);
  assert.equal(Object.values(a.outcomes).reduce((x, y) => x + y, 0), series.length);
  assert.equal(Object.values(a.timePerZone).reduce((x, y) => x + y, 0), series.length);
  assert.deepEqual(a.thresholds, config);
  assert.equal(a.thresholds.policy.exposure.monthlySpendUsd, 10_000);
  assert.ok(a.thresholds.engine.bands && a.thresholds.oracle.minSources === 3 && a.thresholds.smoothing.emaTauMs > 0);
  assert.equal(a.trades.count, a.outcomes.traded);
  assert.match(a.summary, /Rejections by rule/);
  assert.deepEqual(a.start, start);
  assert.equal(a.seedSamples, seed.length);
  assert.match(a.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(a.summary, /regime: replay default/);
});

test("the report replays its own inputs, and the digest covers every one of them", () => {
  const series = syntheticSeries(small), seedHistory = warmupHistory(series[0]!, 35 * DAY, H, 1, 5);
  const inputs = { series, seedHistory, start, config };
  const a = reported(inputs);
  const ran = ok(replay(series, start, config, undefined, seedHistory));
  assert.equal(a.trades.count, ran.trades.length);
  assert.equal(a.endValueUsd, ran.equity[ran.equity.length - 1]!.valueUsd);
  const variants = [
    { ...inputs, series: series.slice(1) },
    { ...inputs, seedHistory: [] },
    { ...inputs, start: { ...start, reserveUsd: start.reserveUsd + 1 } },
    { ...inputs, config: { ...config, seed: 2 } },
  ];
  for (const v of variants) assert.notEqual(reported(v).inputDigest, a.inputDigest);
  // The same inputs written with their keys in another order are the same inputs.
  const { policy, engine, ...rest } = config;
  const reordered = { config: { ...rest, policy, engine }, start: { cashUsd: start.cashUsd, reserveUsd: start.reserveUsd, volatileUsd: start.volatileUsd }, seedHistory, series };
  assert.equal(reported(reordered).inputDigest, a.inputDigest);
});

test("the report counts warm-up freezes and rejections by rule", () => {
  const series = syntheticSeries(small);
  const cold = reported({ series, seedHistory: [], start, config });
  assert.ok(cold.frozen.warmingUp > 0 && cold.frozen.total === cold.frozen.warmingUp);
  const noRate = reported({ series, seedHistory: warmupHistory(series[0]!, 35 * DAY, H, 1, 5), start, config: { ...config, policy: REPLAY_DEFAULTS.policy } });
  assert.equal(noRate.seedSamples, 35 * 24);
  assert.deepEqual(noRate.thresholds.policy, REPLAY_DEFAULTS.policy);
  assert.ok(Object.values(noRate.rejectionsByRule).every(n => n > 0));
});

test("a run the replay refuses is reported as refused, with its problems, and no numbers", () => {
  const series = syntheticSeries(small);
  const refused = calibrationReport({ series: [{ ...series[0]!, price: Number.NaN }, ...series.slice(1)], seedHistory: [], start, config });
  assert.deepEqual(refused, { ok: false, problems: ["the first price must be above zero to value the starting volatile holding"] });
});

test("max drawdown: peak to trough, zero when it never falls, unusable points ignored", () => {
  assert.equal(maxDrawdownPct([{ valueUsd: 100 }, { valueUsd: 120 }, { valueUsd: 90 }, { valueUsd: 110 }]), 25);
  assert.equal(maxDrawdownPct([{ valueUsd: 1 }, { valueUsd: 2 }]), 0);
  assert.equal(maxDrawdownPct([]), 0);
  assert.equal(maxDrawdownPct([{ valueUsd: 100 }, { valueUsd: Number.NaN }, { valueUsd: 50 }]), 50);
});

test("a price is digits, with an optional decimal part and exponent; anything else is unusable", () => {
  // One clean year, with the price of its first row replaced.
  const priced = (price: string) => { const rows: [number, number | string][] = yearOf(); rows[0] = [rows[0]![0], price]; return parseHistory(csv(rows)); };
  for (const ok of ["100", "100.5", ".5", "0001", "1e3", "1.5E-2", "2e+1"]) assert.ok(priced(ok).ok, ok);
  for (const bad of ["1.", "abc", "1e", "1.2.3", "--1", "0x10", "1e3.5", "-"]) assert.equal(priced(bad).ok, false, bad);
});

test("a long malformed price is refused in linear time, not quadratic (CodeQL: polynomial regex)", () => {
  const rows: [number, number | string][] = yearOf();
  rows[0] = [rows[0]![0], "1".repeat(200_000) + "x"];
  const started = performance.now();
  assert.equal(parseHistory(csv(rows)).ok, false);
  assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
});
