import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationRows, bookFigures, DRIFT_MARK } from "../src/proposals/book-view.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const fresh = { priceUpdatedAt: "2026-11-06T11:59:00.000Z", priceExpiresAt: "2026-11-06T12:09:00.000Z" };
const holding = (asset: string, symbol: string, decimals: number, pub: string, conf: string, price: number | null, usd: number | null, times = fresh) =>
  ({ asset, symbol, decimals, public: pub, confidential: conf, price, usd, ...times });
const budgetWindow = (limit: string | null, spent: string, remaining: string | null, resets = "2026-11-07T00:00:00.000Z") => ({ limit_usd: limit, spent_usd: spent, remaining_usd: remaining, resets_at: resets });
const unlimited = budgetWindow(null, "0.000000", null, null as never);
const overview = (book: unknown[], budget: object = { daily: unlimited, weekly: unlimited, monthly: unlimited }, target: Record<string, number> = {}) =>
  ({ book, target, policy: { usage: { budget } } }) as never;

const usdc = holding("nep141:usdc", "USDC", 6, "60000000", "0", 1, 60);
const wnear = holding("nep141:wrap.near", "wNEAR", 24, "0", "10000000000000000000000000", 4, 40);

test("figures: the whole book, what is held privately and its share, and the number of assets", () => {
  const f = bookFigures(overview([usdc, wnear]));
  assert.equal(f.total, 100);
  assert.equal(f.assets, 2);
  // Display only, in floats: close, not exact.
  assert.ok(Math.abs(f.shieldedUsd! - 40) < 1e-9, String(f.shieldedUsd));
  assert.ok(Math.abs(f.shieldedShare! - 0.4) < 1e-9, String(f.shieldedShare));
  assert.equal(f.budget, null, "no USD budget set");
});

test("figures: a held asset without a usable USD value makes the total unavailable, never a partial sum", () => {
  for (const bad of [null, Number.NaN, -1]) {
    const f = bookFigures(overview([usdc, holding("nep141:eth", "ETH", 18, "1", "0", null, bad as never)]));
    assert.deepEqual([f.total, f.shieldedUsd, f.shieldedShare], [null, null, null], String(bad));
  }
});

test("figures: an empty book is zero with no share, not a division by zero", () => {
  const f = bookFigures(overview([]));
  assert.deepEqual([f.total, f.shieldedUsd, f.shieldedShare, f.assets], [0, 0, null, 0]);
});

test("figures: the budget window that refuses first is the limited one with the least left", () => {
  const f = bookFigures(overview([usdc], { daily: budgetWindow("100", "40", "60"), weekly: budgetWindow("500", "480", "20", "2026-11-09T00:00:00.000Z"), monthly: unlimited }));
  assert.deepEqual(f.budget, { period: "Weekly", remaining: "20", spent: "480", limit: 500, resetsAt: "2026-11-09T00:00:00.000Z" });
  const daily = bookFigures(overview([usdc], { daily: budgetWindow("100", "100", "0"), weekly: budgetWindow("500", "100", "400"), monthly: unlimited }));
  assert.equal(daily.budget?.period, "Daily");
  assert.equal(daily.budget?.remaining, "0", "a spent budget reads as none left");
});

test("allocation: weight against target for each asset, exact amounts past 2^53, and a missing target reads as 0", () => {
  const rows = allocationRows(overview([usdc, wnear], undefined, { "nep141:usdc": 0.5 }), NOW);
  assert.deepEqual(rows.map(r => [r.symbol, r.amount, r.usd, r.weight, r.target]), [["USDC", "60", 60, 0.6, 0.5], ["wNEAR", "10", 40, 0.4, 0]]);
  assert.ok(Math.abs(rows[0]!.drift! - 0.1) < 1e-9 && Math.abs(rows[1]!.drift! - 0.4) < 1e-9);
  const big = allocationRows(overview([holding("nep141:wrap.near", "wNEAR", 24, "1", "123456789012345678901234567", 2.5, 308.64)], undefined, {}), NOW);
  assert.equal(big[0]!.amount, "123.456789012345678901234568", "added exactly, never through a float");
});

test("allocation: without a complete total no weight or drift is shown, and a price is fresh, stale or unavailable by its own times", () => {
  const stale = holding("nep141:wrap.near", "wNEAR", 24, "1", "0", 4, 4, { priceUpdatedAt: "2026-11-06T11:00:00.000Z", priceExpiresAt: "2026-11-06T11:10:00.000Z" });
  const missing = holding("nep141:eth", "ETH", 18, "1", "0", null, null);
  const rows = allocationRows(overview([usdc, stale, missing]), NOW);
  assert.deepEqual(rows.map(r => [r.weight, r.drift]), [[null, null], [null, null], [null, null]]);
  assert.deepEqual(rows.map(r => r.price), ["fresh", "stale", "unavailable"]);
  const complete = allocationRows(overview([usdc, stale], undefined, {}), NOW);
  assert.deepEqual(complete.map(r => r.price), ["fresh", "stale"]);
  assert.notEqual(complete[0]!.weight, null);
});

test("a book worth nothing has zero weights, not NaN", () => {
  const rows = allocationRows(overview([holding("nep141:usdc", "USDC", 6, "0", "0", 1, 0)], undefined, { "nep141:usdc": 1 }), NOW);
  assert.deepEqual([rows[0]!.weight, rows[0]!.drift], [0, -1]);
  assert.equal(DRIFT_MARK, 0.02);
});
