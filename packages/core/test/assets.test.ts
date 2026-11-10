import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, assetById, assetBySymbol, isRisk, proposable, registryProblems, VENUE_IDS, type AssetEntry } from "../src/assets.ts";
import { PROPOSAL_ASSETS } from "../src/legs.ts";

test("the registry as shipped has no problems", () => {
  assert.deepEqual(registryProblems(), []);
});

test("what is proposable is exactly the platform's proposal assets: wNEAR, USDC and ETH", () => {
  const tradable = Object.values(ASSET_REGISTRY).filter(proposable).map(e => e.symbol).sort();
  assert.deepEqual(tradable, ["ETH", "USDC", "wNEAR"]);
  for (const [symbol, id] of Object.entries(PROPOSAL_ASSETS)) assert.equal(ASSET_REGISTRY[symbol]?.id, id);
});

test("an asset the platform doesn't list is declared but never proposable", () => {
  for (const symbol of ["BTC", "USDT", "USDC.e", "XAUT", "TBILL"]) {
    assert.ok(ASSET_REGISTRY[symbol], `${symbol} is declared`);
    assert.equal(proposable(ASSET_REGISTRY[symbol]!), false, `${symbol} isn't proposable`);
  }
});

test("the proposable assets carry the SDK's decimals", () => {
  assert.deepEqual([ASSET_REGISTRY.wNEAR!.decimals, ASSET_REGISTRY.USDC!.decimals, ASSET_REGISTRY.ETH!.decimals], [24, 6, 18]);
});

test("ETH reaches NEAR Intents over the Ethereum omft bridge; wNEAR and USDC are native", () => {
  assert.deepEqual(ASSET_REGISTRY.ETH!.venues, [VENUE_IDS.intents, VENUE_IDS.omftEthereum]);
  assert.equal(ASSET_REGISTRY.ETH!.route, "omft");
  assert.deepEqual(ASSET_REGISTRY.wNEAR!.venues, [VENUE_IDS.intents]);
  assert.deepEqual(ASSET_REGISTRY.USDC!.venues, [VENUE_IDS.intents]);
});

test("every asset names three distinct price sources", () => {
  for (const e of Object.values(ASSET_REGISTRY)) assert.equal(new Set(e.priceSources.map(s => s.name)).size, 3, e.symbol);
});

test("risk assets are the volatile ones and a real-world asset that isn't cash-like", () => {
  assert.deepEqual(Object.values(ASSET_REGISTRY).filter(isRisk).map(e => e.symbol).sort(), ["BTC", "ETH", "XAUT", "wNEAR"]);
});

test("lookups: by symbol ignoring case, and by NEAR Intents id", () => {
  assert.equal(assetBySymbol("wnear")?.symbol, "wNEAR");
  assert.equal(assetById(PROPOSAL_ASSETS.ETH)?.symbol, "ETH");
  assert.equal(assetById("nep141:nothing.near"), undefined);
});

test("a broken registry names each problem", () => {
  const eth = ASSET_REGISTRY.ETH!;
  const broken: Record<string, AssetEntry> = {
    ETH: { ...eth, venues: [VENUE_IDS.intents] },
    Other: { ...eth, symbol: "Other2", id: eth.id },
    USDX: { ...ASSET_REGISTRY.USDC!, symbol: "USDX", id: "nep141:usdx.near", pegUsd: undefined },
    GOLD: { ...ASSET_REGISTRY.XAUT!, symbol: "GOLD", id: "nep141:gold.near", rwa: undefined },
  };
  const problems = registryProblems(broken).join(" | ");
  assert.match(problems, /ETH: a native asset crosses no bridge/);
  assert.match(problems, /Other: listed under another symbol/);
  assert.match(problems, /listed twice/);
  assert.match(problems, /USDX: a stablecoin needs its peg/);
  assert.match(problems, /GOLD: a real-world asset, and only one, carries its redemption terms/);
});
