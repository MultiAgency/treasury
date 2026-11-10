import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_DEFAULTS } from "../src/engine.ts";
import type { OracleReading } from "../src/oracle.ts";
import { evaluateSleeves, singleSleeve, sleeveInput, sleeveProblems, type SleeveBook } from "../src/sleeves.ts";

const reading = (twap: number, at = 1_000): OracleReading => ({ frozen: false, asset: "x", median: twap, twap15m: twap, ema30d: 100, at, sources: 3 } as unknown as OracleReading);
const fresh = { dcaUnitsUsed: 0, whipsaw: {} };
// The balanced profile: 40% volatile in [10, 50]; split across wNEAR and ETH, 20% each in [5, 25].
const two: SleeveBook = { sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }], volatileMaxPct: 50 };

test("a book of one sleeve gives the band engine exactly the two-sleeve input", () => {
  const book = singleSleeve("wNEAR", 40, { volatileMinPct: 10, volatileMaxPct: 50 });
  const input = sleeveInput("wNEAR", { volatileUsd: { wNEAR: 40_000 }, reserveUsd: 35_000, cashUsd: 25_000 }, book, fresh, "normal");
  assert.deepEqual(input, {
    portfolio: { volatileUsd: 40_000, reserveUsd: 35_000, cashUsd: 25_000 }, bounds: { volatileMinPct: 10, volatileMaxPct: 50 },
    sizing: { dcaUnitsUsed: 0 }, whipsaw: {}, regime: "normal",
  });
});

test("two sleeves share the reserve by target, and the rest of the book is the sleeve's cash: the total is unchanged", () => {
  const input = sleeveInput("ETH", { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 }, two, fresh, "normal") ?? assert.fail("no input");
  assert.deepEqual(input.portfolio, { volatileUsd: 20_000, reserveUsd: 17_500, cashUsd: 62_500 });
});

test("the other sleeves' weight lowers this one's ceiling, never under its own floor", () => {
  const roomy = sleeveInput("ETH", { volatileUsd: { wNEAR: 20_000, ETH: 10_000 }, reserveUsd: 45_000, cashUsd: 25_000 }, two, fresh, "normal");
  assert.equal(roomy?.bounds.volatileMaxPct, 25);
  const crowded = sleeveInput("ETH", { volatileUsd: { wNEAR: 40_000, ETH: 5_000 }, reserveUsd: 30_000, cashUsd: 25_000 }, two, fresh, "normal");
  assert.equal(crowded?.bounds.volatileMaxPct, 10);
  const full = sleeveInput("ETH", { volatileUsd: { wNEAR: 48_000, ETH: 5_000 }, reserveUsd: 22_000, cashUsd: 25_000 }, two, fresh, "normal");
  assert.equal(full?.bounds.volatileMaxPct, 5);
});

test("an unreadable book, or a sleeve it doesn't have, gives no input", () => {
  const holdings = { volatileUsd: { wNEAR: 1, ETH: 1 }, reserveUsd: 1, cashUsd: 1 };
  assert.equal(sleeveInput("BTC", holdings, two, fresh, "normal"), null);
  assert.equal(sleeveInput("ETH", { ...holdings, reserveUsd: -1 }, two, fresh, "normal"), null);
  assert.equal(sleeveInput("ETH", { volatileUsd: {}, reserveUsd: 0, cashUsd: 0 }, two, fresh, "normal"), null);
});

test("sleeve problems: duplicates, targets outside their bounds, targets over the ceiling", () => {
  assert.deepEqual(sleeveProblems(two), []);
  assert.match(sleeveProblems({ ...two, sleeves: [two.sleeves[0]!, two.sleeves[0]!] }).join(" "), /needs an asset of its own/);
  assert.match(sleeveProblems({ ...two, sleeves: [{ asset: "ETH", targetPct: 30, minPct: 5, maxPct: 25 }] }).join(" "), /min ≤ target ≤ max/);
  assert.match(sleeveProblems({ ...two, volatileMaxPct: 30 }).join(" "), /more than the volatile ceiling/);
  assert.match(sleeveProblems({ sleeves: [], volatileMaxPct: 50 }).join(" "), /at least one volatile sleeve/);
});

test("each sleeve is decided on its own reading: ETH above its reference trims while wNEAR below buys; sells come first", () => {
  const holdings = { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 };
  const decided = evaluateSleeves({ wNEAR: reading(75), ETH: reading(125) }, holdings, two, {}, { wNEAR: "normal", ETH: "normal" }, ENGINE_DEFAULTS);
  assert.deepEqual(decided.map(d => [d.asset, d.intent.action]), [["ETH", "sell-volatile"], ["wNEAR", "buy-volatile"]]);
});

test("an order is sized to its asset's liquidity limit (the registry's maxOrderUsd), not refused for it, and only for that asset", () => {
  // A 5M book: the 2% order cap is 100,000, over wNEAR's 50,000 limit and under ETH's 250,000.
  const holdings = { volatileUsd: { wNEAR: 1_000_000, ETH: 1_000_000 }, reserveUsd: 1_750_000, cashUsd: 1_250_000 };
  const decided = evaluateSleeves({ wNEAR: reading(75), ETH: reading(125) }, holdings, two, {}, { wNEAR: "normal", ETH: "normal" }, ENGINE_DEFAULTS);
  const wnear = decided.find(d => d.asset === "wNEAR")!, eth = decided.find(d => d.asset === "ETH")!;
  assert.equal(wnear.intent.action, "buy-volatile");
  assert.ok(wnear.intent.sizeUsd > 0 && wnear.intent.sizeUsd <= 50_000, String(wnear.intent.sizeUsd));
  assert.equal(wnear.config.sizing.maxOrderPctOfTreasury, 1, "wNEAR's cap is its liquidity limit: 50,000 of 5,000,000");
  assert.equal(eth.config.sizing.maxOrderPctOfTreasury, ENGINE_DEFAULTS.sizing.maxOrderPctOfTreasury, "ETH's limit is above the order cap: unchanged");
});

test("anti-whipsaw is per sleeve: one sleeve's cooldown doesn't hold the other", () => {
  const holdings = { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 };
  const cooling = { dcaUnitsUsed: 0, whipsaw: { lastActionAt: 999, lastAction: "buy-volatile" as const } };
  const decided = evaluateSleeves({ wNEAR: reading(75), ETH: reading(75) }, holdings, two, { wNEAR: cooling }, { wNEAR: "normal", ETH: "normal" }, ENGINE_DEFAULTS);
  assert.equal(decided.find(d => d.asset === "wNEAR")?.intent.action, "hold");
  assert.equal(decided.find(d => d.asset === "ETH")?.intent.action, "buy-volatile");
});

test("a sleeve with no reading, or no regime, holds", () => {
  const holdings = { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: 35_000, cashUsd: 25_000 };
  const decided = evaluateSleeves({ wNEAR: reading(75) }, holdings, two, {}, {}, ENGINE_DEFAULTS);
  assert.ok(decided.every(d => d.intent.action === "hold"));
  assert.match(decided.find(d => d.asset === "ETH")!.intent.reason, /no reading/);
});
