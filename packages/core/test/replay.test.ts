import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, REPLAY_DEFAULTS, seededRandom, SimulatedProvider, type ReplayConfig } from "../src/replay.ts";
import type { Intent } from "../src/bands.ts";
import type { Sample } from "../src/smoothing.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = 1_800_000_000_000;
// 40 days of hourly prices at 100, then a drop to 70 (−30% against the reference: DCA zone), and 10 days at 70.
const series = (days: number, flat = 100, dropTo = 70, dropDays = 10): Sample[] => {
  const out: Sample[] = [];
  for (let i = 0; i <= days * 24; i++) out.push({ at: T0 + i * HOUR, price: flat });
  for (let i = 1; i <= dropDays * 24; i++) out.push({ at: T0 + (days * 24 + i) * HOUR, price: dropTo });
  return out;
};
const config: ReplayConfig = { ...REPLAY_DEFAULTS, policy: { ...REPLAY_DEFAULTS.policy, exposure: { ...REPLAY_DEFAULTS.policy.exposure, monthlySpendUsd: 10_000 } } };
// 20% volatile: inside the 25% venue cap, with room above the 10% floor.
const start = { volatileUsd: 200_000, reserveUsd: 700_000, cashUsd: 100_000 };

test("the seeded generator repeats for a seed and differs between seeds", () => {
  const a = seededRandom(7), b = seededRandom(7), c = seededRandom(8);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every(x => x >= 0 && x < 1));
});

test("a flat series never trades; the first 30 days are frozen as warming-up", () => {
  const r = replay(series(40, 100, 100, 0), start, config);
  assert.equal(r.trades.length, 0);
  assert.ok(r.steps.slice(0, 24 * 30).every(s => s.outcome === "frozen"));
  assert.ok(r.steps.slice(24 * 30 + 1).every(s => s.outcome === "hold"));
});

test("a drop to −30% after warm-up buys in the DCA zone, then waits out the whipsaw gate", () => {
  const r = replay(series(40), start, config);
  assert.ok(r.trades.length >= 1);
  const first = r.trades[0]!;
  assert.equal(first.action, "buy-volatile");
  assert.ok(first.at > T0 + 40 * DAY);
  assert.ok(first.fillPrice > first.midPrice && first.slippageBps >= 5 && first.slippageBps <= 15);
  // spending comes from the reserve only, and units never exceed the DCA budget
  assert.ok(r.portfolio.reserveUsd < start.reserveUsd && r.portfolio.cashUsd === start.cashUsd);
  assert.ok(r.trades.reduce((s, t) => s + t.sizeUsd, 0) <= start.reserveUsd * 0.2 + 1e-6);
});

test("the same run twice gives the same trades; a different seed changes the fills", () => {
  const a = replay(series(40), start, config), b = replay(series(40), start, config);
  assert.deepEqual(a, b);
  const c = replay(series(40), start, { ...config, seed: 2 });
  assert.deepEqual(a.trades.map(t => t.at), c.trades.map(t => t.at));
  assert.notDeepEqual(a.trades.map(t => t.slippageBps), c.trades.map(t => t.slippageBps));
});

test("a frozen oracle produces no trade, even when the price has collapsed", () => {
  const r = replay(series(40), start, { ...config, sources: ["a", "b"] }); // below minSources 3
  assert.equal(r.trades.length, 0);
  assert.ok(r.steps.every(s => s.outcome === "frozen"));
});

test("a policy rejection produces no trade: an unset spend rate rejects every buy", () => {
  const r = replay(series(40), start, REPLAY_DEFAULTS);
  assert.equal(r.trades.length, 0);
  assert.ok(r.steps.some(s => s.outcome === "rejected" && s.rule === "INVALID_INPUT"));
});

test("a non-normal regime holds every step", () => {
  const r = replay(series(40), start, config, () => "system-fault");
  assert.equal(r.trades.length, 0);
});

test("level 2 needs a human, which a replay doesn't have: no trade", () => {
  const r = replay(series(40), start, { ...config, level: 2 });
  assert.equal(r.trades.length, 0);
  assert.ok(r.steps.some(s => s.outcome === "needs-approval"));
});

test("a rise to +30% sells in a trim zone", () => {
  const r = replay(series(40, 100, 130), start, config);
  assert.equal(r.trades[0]?.action, "sell-volatile");
  assert.ok(r.portfolio.reserveUsd > start.reserveUsd);
});

test("the provider never fills twice for one id, nor an order it didn't quote", () => {
  const p = new SimulatedProvider(1);
  const order: Intent = { id: "x", zone: "dca-1", action: "buy-volatile", sizeUsd: 1000, dcaUnits: 1, reason: "", at: 1 };
  assert.equal(p.fill(order, 100).ok, false); // never quoted
  const q = p.quote("x");
  assert.equal(p.quote("x"), q); // the same id gets the same quote
  const first = p.fill(order, 100);
  assert.equal(first.ok, true);
  const second = p.fill(order, 100);
  assert.deepEqual(second, { ok: false, reason: "order x was already filled" });
});

test("an unusable provider model quotes nothing, so nothing fills", () => {
  const p = new SimulatedProvider(1, { baseSlippageBps: Number.NaN, jitterSlippageBps: 1 });
  assert.equal(p.quote("x"), null);
  const r = replay(series(40), start, { ...config, provider: { baseSlippageBps: -1, jitterSlippageBps: 0 } });
  assert.equal(r.trades.length, 0);
});

test("a hold is not an order and an unusable price or size is refused", () => {
  const p = new SimulatedProvider(1);
  const hold: Intent = { id: "h", zone: "hold", action: "hold", sizeUsd: 0, dcaUnits: 0, reason: "", at: 1 };
  assert.equal(p.fill(hold, 100).ok, false);
  const order: Intent = { id: "y", zone: "trim-1", action: "sell-volatile", sizeUsd: 1000, dcaUnits: 0, reason: "", at: 1 };
  p.quote("y");
  assert.equal(p.fill(order, Number.NaN).ok, false);
});
