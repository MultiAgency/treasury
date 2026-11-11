import { test } from "node:test";
import assert from "node:assert/strict";
import { VENUE_IDS } from "../src/assets.ts";
import { bookCalibrationReport, replayBook, type BookReplayConfig } from "../src/book-replay.ts";
import { calibrationReport } from "../src/calibration.ts";
import { syntheticSeries, warmupHistory } from "../src/history.ts";
import { PROFILE_DEFAULTS } from "../src/mandate.ts";
import { REPLAY_DEFAULTS, type ReplayConfig } from "../src/replay.ts";

const H = 3_600_000, DAY = 24 * H, T0 = 1_800_000_000_000;
// HISTORY.md's demo walk, rougher (2.5% a step) so 60 days reach the bands; ETH a walk of its own.
const near = syntheticSeries({ startAt: T0, startPrice: 100, count: 60 * 24, stepMs: H, stepVolPct: 2.5, driftPct: 0, seed: 3 });
const eth = syntheticSeries({ startAt: T0, startPrice: 2_500, count: 60 * 24, stepMs: H, stepVolPct: 2, driftPct: 0, seed: 11 });
const seed = { wNEAR: warmupHistory(near[0]!, 35 * DAY, H, 2.5, 5), ETH: warmupHistory(eth[0]!, 35 * DAY, H, 2, 13) };
const balanced = PROFILE_DEFAULTS.balanced;
const single: ReplayConfig = { ...REPLAY_DEFAULTS, bounds: balanced.bounds,
  policy: { ...REPLAY_DEFAULTS.policy, limits: balanced.limits, exposure: { ...REPLAY_DEFAULTS.policy.exposure, maxVenueExposurePct: 50, monthlySpendUsd: 2_000 } } };
const { asset: _asset, bounds: _bounds, ...shared } = single;
const book = (sleeves: BookReplayConfig["sleeves"], venueCapsPct: Record<string, number>): BookReplayConfig =>
  ({ ...shared, sleeves, volatileMaxPct: 50, venueCapsPct, classCapsPct: { volatile: 50, stable: 100 } });

test("a book of one wNEAR sleeve trades exactly as the single-asset replay does", () => {
  const legacy = calibrationReport({ series: near, seedHistory: seed.wNEAR, start: { volatileUsd: 40_000, reserveUsd: 35_000, cashUsd: 25_000 }, config: single });
  const mine = bookCalibrationReport({ series: { wNEAR: near }, seedHistory: { wNEAR: seed.wNEAR }, start: { volatileUsd: { wNEAR: 40_000 }, reserveUsd: 35_000, cashUsd: 25_000 },
    config: book([{ asset: "wNEAR", targetPct: 40, minPct: 10, maxPct: 50 }], { [VENUE_IDS.intents]: 50 }) });
  if (!legacy.ok || !mine.ok) assert.fail("a run was refused");
  assert.ok(legacy.trades.count > 0, "the run trades");
  assert.equal(mine.trades.count, legacy.trades.count);
  assert.equal(mine.endValueUsd, legacy.endValueUsd);
  assert.equal(mine.maxDrawdownPct, legacy.maxDrawdownPct);
});

test("wNEAR and ETH sleeves each trade, and the run is deterministic", () => {
  const inputs = { series: { wNEAR: near, ETH: eth }, seedHistory: seed, start: { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 },
    config: book([{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }], { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 25 }) };
  const a = bookCalibrationReport(inputs), b = bookCalibrationReport(inputs);
  if (!a.ok || !b.ok) assert.fail("refused");
  assert.ok((a.trades.byAsset.wNEAR ?? 0) > 0 && (a.trades.byAsset.ETH ?? 0) > 0, a.summary);
  assert.deepEqual(a, b);
});

test("at most one proposal an instant, as the server makes at most one a tick: the first sleeve that passes, sells first", () => {
  const run = replayBook({ wNEAR: near, ETH: eth }, { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 },
    book([{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }], { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 25 }), seed);
  if (!run.ok) assert.fail("refused");
  const proposed = new Map<number, number>();
  for (const s of run.steps) if (s.outcome === "traded" || s.outcome === "needs-approval" || s.outcome === "fill-refused") proposed.set(s.at, (proposed.get(s.at) ?? 0) + 1);
  assert.ok(proposed.size > 0, "the run proposes");
  assert.deepEqual([...proposed.values()].filter(n => n > 1), []);
});

test("a BTC sleeve runs, but the platform doesn't list BTC, so every BTC trade is refused", () => {
  const btc = syntheticSeries({ startAt: T0, startPrice: 60_000, count: 60 * 24, stepMs: H, stepVolPct: 1, driftPct: 0, seed: 17 });
  const run = replayBook({ wNEAR: near, BTC: btc }, { volatileUsd: { wNEAR: 20_000, BTC: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 },
    book([{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "BTC", targetPct: 20, minPct: 5, maxPct: 25 }], { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftBitcoin]: 25 }),
    { wNEAR: seed.wNEAR, BTC: warmupHistory(btc[0]!, 35 * DAY, H, 1, 19) });
  if (!run.ok) assert.fail("refused");
  assert.equal(run.trades.filter(t => t.asset === "BTC").length, 0);
  const tried = run.steps.filter(s => s.asset === "BTC" && s.outcome === "rejected");
  assert.ok(tried.length > 0 && tried.every(s => s.rule === "INVALID_INPUT" && /proposal assets/.test(s.detail)));
});

test("series that don't share their instants, or bad sleeves, refuse the run before any step", () => {
  const r = replayBook({ wNEAR: near, ETH: eth.slice(1) }, { volatileUsd: {}, reserveUsd: 1, cashUsd: 1 },
    book([{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 40, minPct: 5, maxPct: 45 }], { [VENUE_IDS.intents]: 50 }));
  assert.equal(r.ok, false);
  const p = !r.ok ? r.problems.join(" ") : "";
  assert.match(p, /same instants/);
  assert.match(p, /more than the volatile ceiling/);
});

test("the bridge's cap holds back an ETH buy the policy alone would allow: a tighter cap stops it with VENUE_EXPOSURE", () => {
  const run = replayBook({ wNEAR: near, ETH: eth }, { volatileUsd: { wNEAR: 40_000, ETH: 0 }, reserveUsd: 35_000, cashUsd: 25_000 },
    book([{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
      { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 0.1 }), seed);
  if (!run.ok) assert.fail("refused");
  // 0.1% of a 100,000 USD book is 100 USD: no ETH buy fits, so every one is refused at the bridge, never filled.
  assert.equal(run.trades.filter(t => t.asset === "ETH" && t.action === "buy-volatile").length, 0);
  const refused = run.steps.filter(s => s.asset === "ETH" && s.outcome === "rejected");
  assert.ok(refused.length > 0, "the ETH sleeve asks to buy at some point");
  assert.ok(refused.every(s => s.rule === "VENUE_EXPOSURE" && /Ethereum bridge/.test(s.detail)), JSON.stringify(refused.slice(0, 3)));
});

test("an unusable starting holding refuses the run before any step", () => {
  const r = replayBook({ wNEAR: near }, { volatileUsd: { wNEAR: 40_000 }, reserveUsd: -1, cashUsd: 25_000 },
    book([{ asset: "wNEAR", targetPct: 40, minPct: 10, maxPct: 50 }], { [VENUE_IDS.intents]: 50 }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problems.join(" ") : "", /starting holding must be zero or more/);
});
