import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, type AssetEntry } from "../src/assets.ts";
import { runwayCash } from "../src/runway.ts";

const on = { rwaEnabled: true, horizonDays: 30 };
// The day the platform lists a tokenized T-bill, stood in for by giving the TBILL slot an id that is a proposal asset
// (ETH's): only what proposability changes is under test.
const { ETH: _eth, ...rest } = ASSET_REGISTRY;
const tbill = ASSET_REGISTRY.TBILL!;
const listed = (redemption: Partial<NonNullable<AssetEntry["rwa"]>["redemption"]> = {}): Record<string, AssetEntry> =>
  ({ ...rest, TBILL: { ...tbill, id: ASSET_REGISTRY.ETH!.id, rwa: { ...tbill.rwa!, redemption: { ...tbill.rwa!.redemption, ...redemption } } } });

test("today the floor counts USDC, and nothing else", () => {
  const r = runwayCash([{ asset: "USDC", usd: 60_000 }, { asset: "wNEAR", usd: 30_000 }, { asset: "ETH", usd: 10_000 }], on);
  assert.equal(r.cashUsd, 60_000);
  assert.deepEqual(r.excluded.map(e => [e.asset, e.reason]), [["wNEAR", "a price exposure, not cash"], ["ETH", "a price exposure, not cash"]]);
});

test("gold is a price exposure, not cash, even though it's a real-world asset", () => {
  assert.equal(runwayCash([{ asset: "XAUT", usd: 5_000 }], on).cashUsd, 0);
});

test("a T-bill the platform doesn't list never counts, sleeve on or off", () => {
  const r = runwayCash([{ asset: "USDC", usd: 10_000 }, { asset: "TBILL", usd: 50_000 }], on);
  assert.equal(r.cashUsd, 10_000);
  assert.match(r.excluded[0]!.reason, /not among the platform's proposal assets/);
  assert.match(runwayCash([{ asset: "TBILL", usd: 50_000 }], { ...on, rwaEnabled: false }).excluded[0]!.reason, /RWA sleeve is off/);
});

test("once listed, a T-bill counts only if it redeems inside the horizon, at its value less the redemption fee", () => {
  assert.equal(runwayCash([{ asset: "TBILL", usd: 50_000 }], on, listed({ feeBps: 10 })).cashUsd, 49_950);
  const slow = runwayCash([{ asset: "TBILL", usd: 50_000 }], { ...on, horizonDays: 2 }, listed());
  assert.equal(slow.cashUsd, 0);
  assert.match(slow.excluded[0]!.reason, /redeems in 3 days, over the 2-day horizon/);
  const small = runwayCash([{ asset: "TBILL", usd: 500 }], on, listed({ minUsd: 1_000 }));
  assert.match(small.excluded[0]!.reason, /under the 1000 USD minimum redemption/);
});

test("an unknown asset or an unusable value leaves the floor unjudged: no number, never a guess", () => {
  assert.equal(runwayCash([{ asset: "USDC", usd: 1 }, { asset: "DOGE", usd: 1 }], on).cashUsd, null);
  assert.equal(runwayCash([{ asset: "USDC", usd: Number.NaN }], on).cashUsd, null);
  assert.equal(runwayCash([{ asset: "USDC", usd: 1 }], { ...on, horizonDays: -1 }).cashUsd, null);
});
