import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSERVATIVE_PROJECTION, project, PROJECTION_DEFAULTS, projectionParamsProblems, type ProjectionParams, type Sample } from "../src/index.ts";
import { AT, book, crash, DAY, H, terms, walk, WNEAR } from "./risk-fixtures.ts";

const flat = (days = 15, at = AT): Sample[] => Array.from({ length: days * 24 + 1 }, (_, i) => ({ at: at - (days * 24 - i) * H, price: 4 }));
const of = (history: Sample[], b = book(), t = terms, params: ProjectionParams = PROJECTION_DEFAULTS) => project(b, t, { [WNEAR]: history }, AT, params);

test("the same inputs give the same projection; a different seed draws differently", () => {
  const history = walk(15, 1);
  assert.deepEqual(of(history), of(history));
  assert.notDeepEqual(of(history).projectedDrawdownPct, of(history, book(), terms, { ...PROJECTION_DEFAULTS, seed: 1 }).projectedDrawdownPct);
});

test("a flat history projects no drawdown, no shortfall and no breach; runway is the stables over plan spend", () => {
  assert.deepEqual(of(flat()), { usable: true, reasons: [], runwayMonths: 30, monthsToFloor: 24, volatileSharePct: 40,
    projectedDrawdownPct: 0, expectedShortfallPct: 0, breachProbabilityPct: 0 });
});

test("a wilder history projects a deeper drawdown and shortfall, and a larger volatile holding a deeper one still", () => {
  const calm = of(walk(15, 1)), wild = of(walk(15, 3)), heavier = of(walk(15, 3), book(70_000, 30_000));
  assert.ok(calm.projectedDrawdownPct > 0 && calm.projectedDrawdownPct < wild.projectedDrawdownPct, `${calm.projectedDrawdownPct} < ${wild.projectedDrawdownPct}`);
  assert.ok(calm.expectedShortfallPct < wild.expectedShortfallPct);
  assert.ok(wild.projectedDrawdownPct < heavier.projectedDrawdownPct);
});

test("a slide is carried forward and a rally isn't: the same noise drifting up projects as if it hadn't drifted", () => {
  const level = of(walk(15, 1, 0, 3)), up = of(walk(15, 1, 0.2, 3)), down = of(walk(15, 1, -0.2, 3));
  assert.ok(Math.abs(up.projectedDrawdownPct - level.projectedDrawdownPct) < 1, `${up.projectedDrawdownPct} ≈ ${level.projectedDrawdownPct}`);
  assert.ok(down.projectedDrawdownPct > level.projectedDrawdownPct + 5, `${down.projectedDrawdownPct} > ${level.projectedDrawdownPct} + 5`);
});

test("a crash in its first day raises the projection: the recent volatility scales the draws up, and a quiet day never scales them down", () => {
  const calm = of(walk(15, 1, 0, 7)), falling = of(crash(30)), fast = of(crash(50));
  assert.ok(falling.projectedDrawdownPct > calm.projectedDrawdownPct + 4, `${falling.projectedDrawdownPct} vs ${calm.projectedDrawdownPct}`);
  assert.ok(fast.projectedDrawdownPct > falling.projectedDrawdownPct);
  // Two wild weeks, then a quiet last day: the fortnight's volatility still counts.
  const wild = walk(15, 3, 0, 9), quiet = wild.map(s => s.at > AT - DAY ? { at: s.at, price: wild.find(x => x.at === AT - DAY)!.price } : s);
  assert.ok(of(quiet).projectedDrawdownPct > of(walk(15, 1, 0, 9)).projectedDrawdownPct);
});

test("with nothing volatile nothing moves, and the floor breaches only if the horizon's spend takes the stables under it", () => {
  const stables = (usd: number) => [{ asset: "USDC", class: "stable" as const, usd, venue: "v" }];
  // 2,000 a month is 66.67 a day: 7 days take 466.67 from the stables, against a 12,000 floor.
  assert.equal(project(stables(12_466.67), terms, {}, AT).breachProbabilityPct, 0);
  assert.equal(project(stables(12_466.66), terms, {}, AT).breachProbabilityPct, 100);
  assert.equal(project(stables(12_466.67), terms, {}, AT).projectedDrawdownPct, 0);
  // A volatile holding worth nothing needs no history.
  assert.equal(project([{ asset: WNEAR, class: "volatile", usd: 0, venue: "v" }, ...stables(50_000)], terms, {}, AT).usable, true);
});

test("the breach probability counts the paths where even selling every volatile asset wouldn't cover the floor", () => {
  assert.equal(of(walk(15, 3), book(1_000, 10_000)).breachProbabilityPct, 100, "the stables are already under the floor");
  assert.equal(of(walk(15, 3), book(40_000, 60_000)).breachProbabilityPct, 0);
  const close = of(walk(15, 5), book(4_000, 9_000));
  assert.ok(close.breachProbabilityPct > 0 && close.breachProbabilityPct < 100, String(close.breachProbabilityPct));
});

test("months to the floor are the stables over it at plan spend, negative once they're under it", () => {
  assert.equal(of(flat(), book(40_000, 18_000)).monthsToFloor, 3);
  assert.equal(of(flat(), book(40_000, 10_000)).monthsToFloor, -1);
  assert.equal(of(flat(), book(40_000, 10_000)).runwayMonths, 5);
});

test("a gap of exactly six hours and a newest price exactly two hours old are allowed; a minute past either isn't", () => {
  const gapped = (ms: number) => flat().filter(s => !(s.at > AT - 5 * DAY && s.at < AT - 5 * DAY + ms));
  assert.equal(of(gapped(6 * H)).usable, true);
  const tooLong = of(gapped(6 * H + 60_000));
  assert.equal(tooLong.usable, false);
  assert.match(tooLong.reasons[0]!, /gap in its history is over 360 minutes/);
  const aged = (ms: number) => flat(15, AT - ms);
  assert.equal(of(aged(2 * H)).usable, true);
  assert.match(of(aged(2 * H + 60_000)).reasons[0]!, /newest price is 121 minutes old/);
});

test("a history missing, too short or empty gives the conservative projection with the reason, never an exception", () => {
  const conservative = { usable: false, ...CONSERVATIVE_PROJECTION };
  for (const [history, why] of [[undefined, "no price history"], [flat(10), "covers less than 14 days"], [[], "no price history in the last 14 days"]] as const) {
    const p = project(book(), terms, history === undefined ? {} : { [WNEAR]: history as Sample[] }, AT);
    assert.deepEqual({ ...p, reasons: undefined }, { ...conservative, reasons: undefined });
    assert.match(p.reasons.join("; "), new RegExp(why));
  }
  assert.equal(project(book(), terms, null as never, AT).usable, false);
  assert.equal(project(book(), terms, { [WNEAR]: flat() }, Number.NaN).usable, false);
  assert.equal(project([], terms, {}, AT).usable, false);
  assert.equal(project(book(), { monthlySpendUsd: 0, operatingCashMonths: 6 }, { [WNEAR]: flat() }, AT).usable, false);
});

test("parameters out of range are refused, each named, and the projection is then the conservative one", () => {
  const bad = { horizonDays: 0, paths: 10_001, lookbackDays: 1.5, confidencePct: 100, seed: -1, liquidationHaircutPct: 100, volHalfLifeHours: 0, maxGapMs: 0, maxAgeMs: Number.NaN };
  assert.equal(projectionParamsProblems(bad).length, Object.keys(bad).length);
  assert.deepEqual(projectionParamsProblems(PROJECTION_DEFAULTS), []);
  assert.equal(of(flat(), book(), terms, { ...PROJECTION_DEFAULTS, paths: 0 }).usable, false);
  assert.deepEqual(projectionParamsProblems(null), ["the projection parameters must be an object"]);
});
