import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExposure, EXPOSURE_CONFIG_DEFAULTS, splitHoldings, type ExposureContext } from "../src/exposure.ts";
import type { Intent } from "../src/bands.ts";

const order = (sizeUsd: number, action: Intent["action"] = "buy-volatile"): Intent =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
// 1,000,000 USD treasury; 50% venue cap = 500,000; spend 10,000/month → 6-month floor 60,000.
const ctx: ExposureContext = { treasuryValueUsd: 1_000_000, venueExposureUsd: 100_000, cashUsd: 100_000, spendsCashUsd: 0 };
// The spend rate is user-defined, so it is part of the limits.
const limits = { ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 10_000 };
const rejected = (r: ReturnType<typeof checkExposure>) => (r.ok === false ? r : assert.fail("expected a rejection"));

test("a hold passes; a normal buy passes", () => {
  assert.deepEqual(checkExposure(order(0, "hold"), ctx, EXPOSURE_CONFIG_DEFAULTS), { ok: true });
  assert.deepEqual(checkExposure(order(10_000), ctx, limits), { ok: true });
});

test("venue exposure: reaching exactly 50% passes, over rejects", () => {
  assert.deepEqual(checkExposure(order(400_000), ctx, limits), { ok: true });
  assert.equal(rejected(checkExposure(order(400_000.01), ctx, limits)).rule, "VENUE_EXPOSURE");
});

test("a sell doesn't add to the venue's exposure", () => {
  assert.deepEqual(checkExposure(order(1_500_000, "sell-volatile"), { ...ctx, venueExposureUsd: 400_000 }, limits), { ok: true });
});

test("no buy while operating cash is under the six-month floor; exactly at the floor is fine", () => {
  assert.deepEqual(checkExposure(order(10_000), { ...ctx, cashUsd: 60_000 }, limits), { ok: true });
  const r = rejected(checkExposure(order(10_000), { ...ctx, cashUsd: 59_999 }, limits));
  assert.deepEqual([r.rule, r.failed], ["CASH_FLOOR", ["CASH_FLOOR"]]);
});

test("a sell is allowed even with cash under the floor (it adds to the reserve)", () => {
  assert.deepEqual(checkExposure(order(10_000, "sell-volatile"), { ...ctx, cashUsd: 1 }, limits), { ok: true });
});

test("an order that uses cash may not leave less than the floor", () => {
  assert.deepEqual(checkExposure(order(10_000), { ...ctx, spendsCashUsd: 40_000 }, limits), { ok: true }); // leaves exactly 60,000
  assert.equal(rejected(checkExposure(order(10_000), { ...ctx, spendsCashUsd: 40_000.01 }, limits)).rule, "CASH_FLOOR");
  assert.equal(rejected(checkExposure(order(10_000, "sell-volatile"), { ...ctx, spendsCashUsd: 50_000 }, limits)).rule, "CASH_FLOOR");
});

test("the floor beats a DCA buy even when every other limit passes", () => {
  const r = rejected(checkExposure(order(1_000), { ...ctx, cashUsd: 10_000 }, limits));
  assert.equal(r.rule, "CASH_FLOOR");
});

test("both failures are listed, venue first", () => {
  const r = rejected(checkExposure(order(450_000), { ...ctx, cashUsd: 10_000 }, limits));
  assert.deepEqual(r.failed, ["VENUE_EXPOSURE", "CASH_FLOOR"]);
});

test("an unknown spend rate or unusable numbers reject as invalid", () => {
  for (const change of [{ treasuryValueUsd: 0 }, { venueExposureUsd: Number.NaN }, { cashUsd: -1 }, { spendsCashUsd: -1 }])
    assert.equal(rejected(checkExposure(order(1_000), { ...ctx, ...change }, limits)).rule, "INVALID_INPUT");
  assert.equal(rejected(checkExposure(order(0), ctx, limits)).rule, "INVALID_INPUT");
});

test("the limits can be changed, and the result is deterministic", () => {
  const narrower = { ...limits, maxVenueExposurePct: 25 };
  assert.equal(rejected(checkExposure(order(300_000), ctx, narrower)).rule, "VENUE_EXPOSURE");
  assert.deepEqual(checkExposure(order(300_000), ctx, limits), { ok: true });
  assert.deepEqual(checkExposure(order(200_000), ctx, limits), checkExposure(order(200_000), ctx, limits));
});

test("an unset or unusable user spend rate rejects every buy: the floor can't be checked", () => {
  for (const monthlySpendUsd of [null, -1, Number.NaN])
    assert.equal(rejected(checkExposure(order(1_000), ctx, { ...limits, monthlySpendUsd })).rule, "INVALID_INPUT");
  assert.equal(rejected(checkExposure(order(1_000), ctx)).rule, "INVALID_INPUT");
});

test("the floor follows the user's spend rate", () => {
  assert.deepEqual(checkExposure(order(1_000), { ...ctx, cashUsd: 120_000 }, { ...limits, monthlySpendUsd: 20_000 }), { ok: true });
  assert.equal(rejected(checkExposure(order(1_000), { ...ctx, cashUsd: 119_999 }, { ...limits, monthlySpendUsd: 20_000 })).rule, "CASH_FLOOR");
});

test("cash is stablecoins; every other asset is a risk asset", () => {
  const holdings = [{ symbol: "USDC", usd: 50_000 }, { symbol: " usdt ", usd: 10_000 }, { symbol: "wNEAR", usd: 200_000 }, { symbol: "BTC", usd: 5_000 }];
  assert.deepEqual(splitHoldings(holdings, ["USDC", "USDT"]), { cashUsd: 60_000, riskAssetsUsd: 205_000 });
  assert.equal(splitHoldings([{ symbol: "USDC", usd: Number.NaN }], ["USDC"]), null);
  assert.equal(splitHoldings([{ symbol: "USDC", usd: -1 }], ["USDC"]), null);
});
