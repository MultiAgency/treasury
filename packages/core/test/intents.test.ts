import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, DRIFT_DEFAULTS, livePrices, parseIntentsTokens, quoteCostBps, quoteProblems, registryDrift, type DryQuote, type IntentsToken } from "../src/index.ts";
import { AT, liveTokens } from "./intents-fixtures.ts";

const raw = (t: IntentsToken) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: t.price, priceUpdatedAt: new Date(t.priceUpdatedAt!).toISOString() });

test("the registry matches the live token list: no drift on the ids, decimals and chains the app was written against", () => {
  assert.deepEqual(registryDrift(liveTokens(), AT), []);
});

test("an id the list drops, wrong decimals or a moved chain are each drift; the symbol alone is not (USDC.e is the list's USDC)", () => {
  const tokens = liveTokens();
  const without = tokens.filter(t => t.assetId !== ASSET_REGISTRY.XAUT!.id);
  assert.deepEqual(registryDrift(without, AT).map(d => [d.asset, d.kind]), [["XAUT", "missing"]]);
  const changed = tokens.map(t => t.assetId === ASSET_REGISTRY.ETH!.id ? { ...t, decimals: 8, blockchain: "arb" } : t);
  assert.deepEqual(registryDrift(changed, AT).map(d => [d.asset, d.kind]), [["ETH", "decimals"], ["ETH", "chain"]]);
  assert.deepEqual(registryDrift(tokens, AT).filter(d => d.asset === "USDC.e"), []);
});

test("an unpriced, stale or off-peg token is reported, and a stale or unpriced one has no live price", () => {
  const tokens = liveTokens().map(t => t.symbol === "SOL" ? { ...t, price: null } : t.symbol === "BTC" ? { ...t, priceUpdatedAt: AT - DRIFT_DEFAULTS.maxPriceAgeMs - 1 }
    : t.symbol === "USDT" ? { ...t, price: 0.97 } : t);
  assert.deepEqual(registryDrift(tokens, AT).map(d => [d.asset, d.kind]), [["BTC", "stale-price"], ["SOL", "unpriced"], ["USDT", "off-peg"]]);
  const prices = livePrices(tokens, AT);
  assert.equal(prices.SOL, undefined);
  assert.equal(prices.BTC, undefined);
  assert.equal(prices.XAUT, 4018.56);
});

test("the T-bill slot has no id, so there is nothing to compare and no price", () => {
  assert.ok(!registryDrift(liveTokens(), AT).some(d => d.asset === "TBILL"));
  assert.equal(livePrices(liveTokens(), AT).TBILL, undefined);
});

test("a token list is parsed as untrusted: malformed entries are dropped and counted, duplicates keep the first, a copy is returned", () => {
  const good = liveTokens().slice(0, 2).map(raw);
  const parsed = parseIntentsTokens([...good, { ...good[0]! }, { assetId: "x", symbol: "X" }, null, "nope", { ...good[1]!, assetId: "nep141:other", decimals: 1.5 },
    { ...good[1]!, assetId: "nep141:neg", price: -1 }, { ...good[1]!, assetId: "nep141:bad id with spaces" }, { ...good[1]!, assetId: "nep141:nan", price: Number.NaN }]);
  assert.equal(parsed.tokens.length, 2);
  assert.equal(parsed.rejected, 8);
  assert.notEqual(parsed.tokens[0], good[0]);
  assert.deepEqual(parseIntentsTokens({ tokens: [] }).problems, ["the token list isn't a list"]);
  assert.deepEqual(parseIntentsTokens([]).problems, ["the token list holds no readable token"]);
  assert.equal(parseIntentsTokens(new Array(5_001).fill(good[0])).tokens.length, 0);
});

const quote = (change: Partial<DryQuote> = {}): DryQuote => ({ from: "USDC", to: "XAUT", amountInUsd: 999.547, amountOutUsd: 996.40999, minAmountOutUsd: 986.4, amountIn: "1000000000", amountOut: "247952", at: AT, ...change });

test("a quote's cost is what NEAR Intents' own valuations lose between the two sides, in basis points; a gain reads as zero, never a credit", () => {
  assert.equal(Math.round(quoteCostBps(quote())! * 10) / 10, 31.4);
  assert.equal(quoteCostBps(quote({ amountOutUsd: 1_000 })), 0);
});

test("a quote that can't be read has no cost: a missing figure, the same asset both sides, a zero amount or no time", () => {
  for (const bad of [quote({ amountInUsd: 0 }), quote({ amountOutUsd: Number.NaN }), quote({ to: "USDC" }), quote({ amountOut: "0" }), quote({ amountIn: "1.5" }), quote({ at: Number.NaN })]) {
    assert.ok(quoteProblems(bad).length > 0);
    assert.equal(quoteCostBps(bad), null);
  }
  assert.equal(quoteProblems(null)[0], "the quote isn't an object");
});
