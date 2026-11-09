import { test } from "node:test";
import assert from "node:assert/strict";
import { VENUE_IDS } from "../src/assets.ts";
import type { Intent } from "../src/bands.ts";
import { bookContext, bookExposure, checkBookExposure, combineResults, type BookExposureLimits } from "../src/exposure.ts";

const order = (sizeUsd: number, action: Intent["action"] = "buy-volatile"): Intent =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
// 100,000 USD: wNEAR 20,000, ETH 15,000, USDC 65,000. The account at 50%, the Ethereum bridge at 25%, volatile at 50%.
const holdings = [{ asset: "wNEAR", usd: 20_000 }, { asset: "ETH", usd: 15_000 }, { asset: "USDC", usd: 65_000 }];
const limits: BookExposureLimits = { venueCapsPct: { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 25 }, classCapsPct: { volatile: 50, stable: 100 } };
const ctx = (asset: string) => bookContext(asset, holdings, 100_000) ?? assert.fail("no context");
const rejected = (r: ReturnType<typeof checkBookExposure>) => (r.ok === false ? r : assert.fail("expected a rejection"));

test("a holding counts at every venue on its path: ETH at the account and at the Ethereum bridge", () => {
  const e = bookExposure(holdings) ?? assert.fail("unusable");
  assert.deepEqual(e.venueUsd, { [VENUE_IDS.intents]: 35_000, [VENUE_IDS.omftEthereum]: 15_000 });
  assert.deepEqual(e.classUsd, { volatile: 35_000, stable: 65_000 });
});

test("a stablecoin is cash at the account, but a bridged one still counts at its bridge", () => {
  const e = bookExposure([{ asset: "USDC.e", usd: 10_000 }, { asset: "USDC", usd: 5_000 }]) ?? assert.fail("unusable");
  assert.deepEqual(e.venueUsd, { [VENUE_IDS.omftEthereum]: 10_000 });
});

test("an asset outside the registry, or an unusable value, can't be counted", () => {
  assert.equal(bookExposure([{ asset: "DOGE", usd: 1 }]), null);
  assert.equal(bookExposure([{ asset: "ETH", usd: Number.NaN }]), null);
  assert.equal(bookContext("DOGE", holdings, 100_000), null);
});

test("a buy within every cap passes; reaching the bridge cap exactly passes, over it is VENUE_EXPOSURE", () => {
  assert.deepEqual(checkBookExposure(order(5_000), ctx("ETH"), limits), { ok: true });
  assert.deepEqual(checkBookExposure(order(10_000), ctx("ETH"), limits), { ok: true });
  const r = rejected(checkBookExposure(order(10_000.01), ctx("ETH"), limits));
  assert.equal(r.rule, "VENUE_EXPOSURE");
  assert.match(r.detail, /Ethereum bridge/);
});

test("wNEAR crosses no bridge, so the Ethereum bridge's cap never holds it back", () => {
  assert.deepEqual(checkBookExposure(order(15_000), ctx("wNEAR"), limits), { ok: true });
});

test("the class cap holds back a buy the venues would allow", () => {
  const r = rejected(checkBookExposure(order(14_000), ctx("wNEAR"), { ...limits, venueCapsPct: { ...limits.venueCapsPct, [VENUE_IDS.intents]: 100 }, classCapsPct: { volatile: 45 } }));
  assert.deepEqual(r.failed, ["CLASS_EXPOSURE"]);
});

test("an order over the asset's liquidity limit is ORDER_SIZE, buy or sell", () => {
  assert.equal(rejected(checkBookExposure(order(50_000.01, "sell-volatile"), ctx("wNEAR"), limits)).rule, "ORDER_SIZE");
});

test("a sell only lowers exposure: no venue or class cap applies to it", () => {
  assert.deepEqual(checkBookExposure(order(14_000, "sell-volatile"), ctx("ETH"), { ...limits, venueCapsPct: { [VENUE_IDS.intents]: 1, [VENUE_IDS.omftEthereum]: 1 } }), { ok: true });
});

test("an asset the platform doesn't list is refused, whatever the caps", () => {
  const btc = bookContext("BTC", [...holdings, { asset: "BTC", usd: 0 }], 100_000) ?? assert.fail("no context");
  const r = rejected(checkBookExposure(order(1), btc, { ...limits, venueCapsPct: { ...limits.venueCapsPct, [VENUE_IDS.omftBitcoin]: 25 } }));
  assert.equal(r.rule, "INVALID_INPUT");
  assert.match(r.detail, /BTC isn't among the platform's proposal assets/);
});

test("a venue on the path with no cap, or a cap out of range, is invalid input: it never reads as uncapped", () => {
  assert.equal(rejected(checkBookExposure(order(1), ctx("ETH"), { ...limits, venueCapsPct: { [VENUE_IDS.intents]: 50 } })).rule, "INVALID_INPUT");
  assert.equal(rejected(checkBookExposure(order(1), ctx("ETH"), { ...limits, venueCapsPct: { ...limits.venueCapsPct, [VENUE_IDS.omftEthereum]: 0 } })).rule, "INVALID_INPUT");
  assert.equal(rejected(checkBookExposure(order(1), ctx("ETH"), { ...limits, venueCapsPct: { ...limits.venueCapsPct, "made-up": 10 } })).rule, "INVALID_INPUT");
});

test("a hold always passes", () => {
  assert.deepEqual(checkBookExposure(order(0, "hold"), ctx("ETH"), limits), { ok: true });
});

test("results combine as checkPolicy's: every rejection listed in rule order, else needs-approval, else ok", () => {
  const combined = combineResults([
    { ok: "needs-approval", reason: "L2" },
    { ok: false, rule: "CASH_FLOOR", detail: "a", failed: ["CASH_FLOOR"] },
    { ok: false, rule: "VENUE_EXPOSURE", detail: "b", failed: ["VENUE_EXPOSURE", "CLASS_EXPOSURE"] },
  ]);
  assert.deepEqual(combined, { ok: false, rule: "VENUE_EXPOSURE", detail: "a; b", failed: ["VENUE_EXPOSURE", "CLASS_EXPOSURE", "CASH_FLOOR"] });
  assert.deepEqual(combineResults([{ ok: true }, { ok: "needs-approval", reason: "L2" }]), { ok: "needs-approval", reason: "L2" });
  assert.deepEqual(combineResults([{ ok: true }]), { ok: true });
});
