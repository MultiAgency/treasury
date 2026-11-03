import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExposure, EXPOSURE_DEFAULTS, type ExposureContext } from "../src/exposure.ts";
import type { Proposal } from "../src/bands.ts";

const order = (sizeUsd: number, action: Proposal["action"] = "buy-volatile"): Proposal =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
// 1,000,000 USD treasury; 25% venue cap = 250,000; spend 10,000/month → 6-month floor 60,000.
const ctx: ExposureContext = { treasuryValueUsd: 1_000_000, venueExposureUsd: 100_000, cashUsd: 100_000, monthlySpendUsd: 10_000, spendsCashUsd: 0 };
const rejected = (r: ReturnType<typeof checkExposure>) => (r.ok === false ? r : assert.fail("expected a rejection"));

test("a hold passes; a normal buy passes", () => {
  assert.deepEqual(checkExposure(order(0, "hold"), { ...ctx, monthlySpendUsd: null }), { ok: true });
  assert.deepEqual(checkExposure(order(10_000), ctx), { ok: true });
});

test("venue exposure: reaching exactly 25% passes, over rejects", () => {
  assert.deepEqual(checkExposure(order(150_000), ctx), { ok: true });
  assert.equal(rejected(checkExposure(order(150_000.01), ctx)).rule, "VENUE_EXPOSURE");
});

test("a sell doesn't add to the venue's exposure", () => {
  assert.deepEqual(checkExposure(order(1_500_000, "sell-volatile"), { ...ctx, venueExposureUsd: 400_000 }), { ok: true });
});

test("no buy while operating cash is under the six-month floor; exactly at the floor is fine", () => {
  assert.deepEqual(checkExposure(order(10_000), { ...ctx, cashUsd: 60_000 }), { ok: true });
  const r = rejected(checkExposure(order(10_000), { ...ctx, cashUsd: 59_999 }));
  assert.deepEqual([r.rule, r.failed], ["CASH_FLOOR", ["CASH_FLOOR"]]);
});

test("a sell is allowed even with cash under the floor (it adds to the reserve)", () => {
  assert.deepEqual(checkExposure(order(10_000, "sell-volatile"), { ...ctx, cashUsd: 1 }), { ok: true });
});

test("an order that uses cash may not leave less than the floor", () => {
  assert.deepEqual(checkExposure(order(10_000), { ...ctx, spendsCashUsd: 40_000 }), { ok: true }); // leaves exactly 60,000
  assert.equal(rejected(checkExposure(order(10_000), { ...ctx, spendsCashUsd: 40_000.01 })).rule, "CASH_FLOOR");
  assert.equal(rejected(checkExposure(order(10_000, "sell-volatile"), { ...ctx, spendsCashUsd: 50_000 })).rule, "CASH_FLOOR");
});

test("the floor beats a DCA buy even when every other limit passes", () => {
  const r = rejected(checkExposure(order(1_000), { ...ctx, cashUsd: 10_000 }));
  assert.equal(r.rule, "CASH_FLOOR");
});

test("both failures are listed, venue first", () => {
  const r = rejected(checkExposure(order(200_000), { ...ctx, cashUsd: 10_000 }));
  assert.deepEqual(r.failed, ["VENUE_EXPOSURE", "CASH_FLOOR"]);
});

test("an unknown spend rate or unusable numbers reject as invalid", () => {
  for (const change of [{ monthlySpendUsd: null }, { monthlySpendUsd: -1 }, { treasuryValueUsd: 0 }, { venueExposureUsd: Number.NaN }, { cashUsd: -1 }, { spendsCashUsd: -1 }])
    assert.equal(rejected(checkExposure(order(1_000), { ...ctx, ...change })).rule, "INVALID_INPUT");
  assert.equal(rejected(checkExposure(order(0), ctx)).rule, "INVALID_INPUT");
});

test("the limits can be changed, and the result is deterministic", () => {
  const limits = { ...EXPOSURE_DEFAULTS, maxVenueExposurePct: 50 };
  assert.deepEqual(checkExposure(order(300_000), ctx, limits), { ok: true });
  assert.deepEqual(checkExposure(order(200_000), ctx), checkExposure(order(200_000), ctx));
});
