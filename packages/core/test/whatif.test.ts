import { test } from "node:test";
import assert from "node:assert/strict";
import { stressRun, whatIf, whatIfProblems, type Book } from "../src/index.ts";
import { book, terms, USDC, WNEAR } from "./risk-fixtures.ts";

test("a fall over the book is the stress run's own result, beside the book today", () => {
  const r = whatIf(book(), terms, { volatileDropPct: 50 });
  assert.ok(r.ok);
  assert.equal(r.after.lossUsd, 20_000);
  assert.equal(r.now.lossUsd, 0, "today loses nothing");
  assert.deepEqual(r.after, stressRun(book(), terms, r.scenario), "the same run the agent's scenarios use");
  assert.equal(r.label, "wNEAR falls 50%");
});

test("events combine into one scenario: a fall with spend at twice the plan halves the runway the stables fund", () => {
  const r = whatIf(book(), terms, { volatileDropPct: 30, spendFactor: 2 });
  assert.ok(r.ok);
  assert.equal(r.scenario.shocks.length, 2);
  assert.equal(r.after.runwayMonths, r.now.runwayMonths / 2);
});

test("a stablecoin price and an outage are applied to what the book holds, and may be limited to one asset or venue", () => {
  const depeg = whatIf(book(), terms, { stablePrice: 0.9, asset: USDC });
  assert.ok(depeg.ok);
  assert.equal(depeg.after.stableUsd, 54_000);
  const outage = whatIf(book(), terms, { venueOutageDays: 7, venue: "NEAR Intents" });
  assert.ok(outage.ok);
  assert.equal(outage.after.tradable, false);
});

test("an event that names nothing, or is out of range, is refused with its reasons, never a result", () => {
  assert.deepEqual(whatIf(book(), terms, {}), { ok: false, problems: ["name at least one event: a fall, a stablecoin price, an outage, a spend factor or stale prices"] });
  for (const bad of [{ volatileDropPct: 0 }, { volatileDropPct: 101 }, { volatileDropPct: Number.NaN }, { stablePrice: -1 }, { spendFactor: 21 }, { venueOutageDays: 0 }, { staleDays: 31 }, { volatileDropPct: "50" }]) {
    const r = whatIf(book(), terms, bad as never);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.ok(whatIfProblems(null).length > 0 && whatIfProblems([]).length > 0);
});

test("a named asset or venue the book doesn't hold is refused, and so is a price event that touches nothing held", () => {
  assert.deepEqual(whatIf(book(), terms, { volatileDropPct: 30, asset: "BTC" }), { ok: false, problems: ["the book holds no BTC"] });
  assert.deepEqual(whatIf(book(), terms, { venueOutageDays: 1, venue: "Elsewhere" }), { ok: false, problems: ["the book holds nothing at Elsewhere"] });
  // Dropping a stablecoin-only asset by the volatile fall touches no volatile holding.
  const r = whatIf(book(), terms, { volatileDropPct: 30, asset: USDC });
  assert.deepEqual(r, { ok: false, problems: ["the event touches nothing the book holds"] });
});

test("an unreadable book or terms fail closed with the reasons", () => {
  const empty = whatIf([] as Book, terms, { volatileDropPct: 30 });
  assert.equal(empty.ok, false);
  const noTerms = whatIf(book(), { monthlySpendUsd: 0, operatingCashMonths: 6 }, { volatileDropPct: 30 });
  assert.equal(noTerms.ok, false);
  assert.ok(WNEAR);
});
